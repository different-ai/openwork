import { randomBytes, randomUUID } from "node:crypto";
import { DaytonaApi, type Sandbox } from "./api.ts";
import type { DaytonaEvidenceLaunch } from "./builder.ts";

import { COPY_KIND, EVIDENCE_KIND } from "./kinds.ts";
import { boundedDiagnostic, failureLayer, inspectGuest, safeExternalResponse } from "./health.ts";
import { daytonaPreviewRoute, daytonaSshRoute } from "./routes.ts";
import { connectSandboxPort, isCdpVersion, RELAY_UNREACHABLE_HEADER, SandboxConnectError, type Readiness, type RouteOutcome, type SandboxConnection, type SandboxRoute, type SshOptions } from "@openwork/sandbox-connect";

export { EVIDENCE_KIND };
const ROOT = "/opt/openwork-preview";
const ACCESS_FILE = `${ROOT}/access.json`;
/** Access to a test world expires after this long. */
const WORLD_MINUTES = 60;
/**
 * Daytona stops a sandbox after this many idle minutes and deletes it as soon as
 * it stops, so a world is reclaimed even if the runner dies. The hourly cleanup
 * is the backstop.
 */
const IDLE_STOP_MINUTES = 30;

export interface DaytonaEvidenceSession {
  id: string;
  sourceSha: string;
  /** Reviewer viewer (noVNC + controls), behind the access cookie and the Daytona token. */
  viewer: { url: string; previewToken: string };
  /** Chrome's remote-control port, for the runner only. */
  cdp: { url: string; previewToken: string };
  /** `__Host-openwork-preview=<token>`: the in-VM gateway's access cookie. */
  cookie: string;
  expiresAt: string;
}

export interface CdpWaitOptions {
  probe?: typeof fetch;
  attempts?: number;
  pauseMs?: number;
  diagnostic?: (summary: string) => Promise<void>;
  diagnosticTimeoutMs?: number;
  /** Known credentials to suppress even if echoed as an otherwise valid trace ID. */
  secrets?: readonly string[];
  /** Overrides for the SSH client (tests use a stand-in). */
  ssh?: Omit<SshOptions, "signal" | "readyTimeoutMs">;
}

/** Starts an isolated template copy, or takes ownership of this run's freshly prepared VM. */
export async function launchDaytonaEvidenceWorld(template: DaytonaEvidenceLaunch, sourceSha: string, api = new DaytonaApi(), options: CdpWaitOptions = {}): Promise<DaytonaEvidenceSession & { browser: SandboxConnection }> {
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !/^[a-f0-9]{40}$/.test(template.runtimeFingerprint)) throw new Error("Full source SHA and runtime fingerprint required");
  if ("sandbox" in template && (template.sandbox.labels.kind !== EVIDENCE_KIND || template.sandbox.labels.sourceSha !== sourceSha)) {
    throw new Error("Refusing to adopt an unrelated prepared world");
  }
  const created = "sandbox" in template ? template.sandbox : await api.createSandbox({ name: `ow-dy-evidence-${randomUUID().replaceAll("-", "")}`, snapshot: template.name,
    labels: { kind: EVIDENCE_KIND, sourceSha }, autoStopMinutes: IDLE_STOP_MINUTES, autoDeleteMinutes: 0 });
  let owned = true;
  let diagnosticSandbox = created;
  const credentials = new Set([api.config.apiKey, ...(options.secrets ?? [])]);
  try {
    const sandbox = await api.waitForSandbox(created.id, ["started"]);
    if (sandbox.id !== created.id || ("sandbox" in template && (sandbox.labels.kind !== EVIDENCE_KIND || sandbox.labels.sourceSha !== sourceSha))) {
      owned = false;
      throw new Error("Refusing to adopt an unrelated prepared world");
    }
    diagnosticSandbox = sandbox;
    if ("sandbox" in template && (await api.readFile(sandbox, `${ROOT}/built-from-sha`))?.trim() !== sourceSha) throw new Error("Prepared world source mismatch");
    // A template may serve several commits whose VM-side files are identical.
    if ((await api.readFile(sandbox, `${ROOT}/evidence-ready`))?.trim() !== "web-v1"
      || (await api.readFile(sandbox, `${ROOT}/runtime-fingerprint`))?.trim() !== template.runtimeFingerprint) throw new Error("Evidence world source mismatch");
    const [viewer, cdp] = await Promise.all([api.previewUrl(sandbox.id, 8080), api.previewUrl(sandbox.id, 8081)]);
    credentials.add(viewer.token); credentials.add(cdp.token);
    const token = randomBytes(32).toString("base64url");
    credentials.add(token);
    const expiresAt = new Date(Date.now() + WORLD_MINUTES * 60_000).toISOString();
    // No origins: each gateway forwards to its one pinned service (see GATEWAY_UNITS).
    await api.writeFile(sandbox, ACCESS_FILE, JSON.stringify({ sandboxId: sandbox.id, sourceSha, token, expiresAt }), 0o600);
    const session: DaytonaEvidenceSession = { id: sandbox.id, sourceSha, cookie: `__Host-openwork-preview=${token}`, expiresAt,
      viewer: { url: viewer.url, previewToken: viewer.token }, cdp: { url: cdp.url, previewToken: cdp.token } };
    // The SSH gateway is a second, independent way in; without it only the preview proxy is tried.
    const ssh = await daytonaSshRoute(api, sandbox.id, 8081, { cookie: session.cookie }, WORLD_MINUTES).catch(() => undefined);
    if (ssh) credentials.add(ssh.user);
    const browser = await connectEvidenceCdp(session, { ...options, routes: ssh ? [ssh] : [], secrets: [...credentials] });
    return { ...session, browser };
  } catch (error) {
    if (!owned) throw error;
    // Persist the safe external facts before a toolbox call can stall. This
    // synchronous fallback also survives failure of a caller's diagnostic sink.
    const external = error instanceof CdpReadinessError ? error.history : [];
    const routes = error instanceof CdpReadinessError ? error.routes : [];
    const publicResource = (value: string | undefined, pattern: RegExp) => value && pattern.test(value)
      && ![...credentials].some((secret) => secret.length > 0 && value.toLowerCase().includes(secret.toLowerCase())) ? value : undefined;
    const context = { sourceSha,
      sandboxId: publicResource(created.id, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/),
      parentSnapshot: publicResource(diagnosticSandbox.snapshot, /^ow-dy-evidence-(?:image|web)-v1-[a-f0-9]{40}$/) };
    try { console.error(JSON.stringify({ stage: "daytona-evidence-external", ...context, external, routes })); }
    catch { /* A broken log sink must not mask the original failure or skip teardown. */ }
    // Collect while the owned VM still exists. Never publish the error text,
    // URLs, access file, service environment, or unfiltered guest logs.
    await boundedDiagnostic(async () => {
      const health = await inspectGuest(api, diagnosticSandbox).catch(() => undefined);
      const status = external.at(-1)?.status ?? 0;
      const summary = JSON.stringify({ stage: "daytona-evidence-launch", ...context, at: new Date().toISOString(), layer: external.length > 0 ? failureLayer(health, status, external.at(-1)?.body) : "unresolved", external, routes, health: health ?? "unavailable" });
      if (options.diagnostic) await options.diagnostic(summary);
      else console.error(summary);
    }, options.diagnosticTimeoutMs);
    await api.deleteSandbox(created.id).catch(() => undefined);
    throw error;
  }
}

export class CdpReadinessError extends Error {
  readonly history: ReturnType<typeof safeExternalResponse>[];
  /** How each route fared (preview, SSH): kind, label and a fixed reason word. */
  readonly routes: RouteOutcome[];
  constructor(history: ReturnType<typeof safeExternalResponse>[], routes: RouteOutcome[] = []) {
    super(`The evidence browser did not answer (HTTP ${history.at(-1)?.status ?? 0}${routes.length > 1 ? `; ${routes.map((route) => `${route.route.label} ${route.result}${route.reason ? ` ${route.reason}` : ""}`).join(", ")}` : ""})`);
    this.history = history;
    this.routes = routes;
  }
}

async function boundedBody(response: Response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < 8_192) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value.subarray(0, 8_192 - bytes);
      chunks.push(chunk); bytes += chunk.length;
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks).toString("utf8");
}

export const PREVIEW_ROUTE_LABEL = "daytona-preview";

/**
 * Connects to the resumed browser through both access checks, racing the
 * preview proxy against any extra routes (the SSH gateway). Returns a loopback
 * CDP URL the caller closes. Preview probes are kept, sanitized, for the
 * failure classifier; auth errors are not boot delays.
 */
export async function connectEvidenceCdp(session: Pick<DaytonaEvidenceSession, "cdp" | "cookie">, options: CdpWaitOptions & { routes?: readonly SandboxRoute[] } = {}): Promise<SandboxConnection> {
  const history: ReturnType<typeof safeExternalResponse>[] = [];
  const probe = options.probe ?? fetch;
  const secrets = [...(options.secrets ?? []), session.cdp.previewToken, session.cookie, session.cookie.slice(session.cookie.indexOf("=") + 1)];
  const attempts = options.attempts ?? 60;
  let previewChecks = 0;
  const preview = { ...daytonaPreviewRoute({ url: session.cdp.url, token: session.cdp.previewToken }, { cookie: session.cookie }), label: PREVIEW_ROUTE_LABEL };
  try {
    return await connectSandboxPort([preview, ...(options.routes ?? [])], { timeoutMs: 70_000, pauseMs: options.pauseMs ?? 1_000, ssh: options.ssh, async check(url, route, signal): Promise<Readiness> {
      const isPreview = route.label === PREVIEW_ROUTE_LABEL;
      let status = 0;
      try {
        const response = await (isPreview ? probe : fetch)(`${url}/json/version`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
        // The relay's own "could not reach Daytona" is a network failure (0), not a provider 502.
        status = response.headers.has(RELAY_UNREACHABLE_HEADER) ? 0 : response.status;
        const body = await boundedBody(response).catch(() => "");
        if (isPreview) history.push(safeExternalResponse(status, response.headers, body, secrets));
        if (response.ok && isCdpVersion(body)) return "ready";
      } catch { if (isPreview && !signal.aborted) history.push(safeExternalResponse(0, new Headers(), "")); }
      if (history.length > 8) history.shift();
      if ([401, 403].includes(status)) return "fail";
      if (isPreview && ++previewChecks >= attempts) return "fail";
      return "retry";
    } });
  } catch (error) {
    if (error instanceof SandboxConnectError) throw new CdpReadinessError(history, error.outcomes);
    throw error;
  }
}

/** Waits until the evidence browser answers, then closes the probe connection. */
export async function waitForCdp(session: Pick<DaytonaEvidenceSession, "cdp" | "cookie">, options: CdpWaitOptions = {}) {
  await (await connectEvidenceCdp(session, options)).close();
}

export async function deleteDaytonaEvidenceWorld(id: string, api = new DaytonaApi()) {
  const sandbox = await api.getSandbox(id);
  if (!sandbox) return;
  if (sandbox.labels.kind !== EVIDENCE_KIND) throw new Error("Refusing to delete an unrelated sandbox");
  await api.deleteSandbox(id);
}

/** Controls the held demonstration stream in a test world or a reviewer's copy. */
export async function evidenceControl(id: string, command: "continue" | "state", api = new DaytonaApi()): Promise<string> {
  const sandbox: Sandbox | null = await api.getSandbox(id);
  if (!sandbox || ![EVIDENCE_KIND, COPY_KIND].includes(sandbox.labels.kind ?? "")) throw new Error("Not a Daytona evidence world");
  return api.execChecked(sandbox, `node ${ROOT}/evidence-control.mjs ${command}`, 30);
}
