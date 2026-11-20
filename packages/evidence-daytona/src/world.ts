import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DaytonaApi, type Sandbox } from "./api.ts";
import { LOCALHOST_RECIPE } from "./localhost.ts";
import type { DaytonaEvidenceLaunch } from "./builder.ts";

import { COPY_KIND, EVIDENCE_KIND } from "./kinds.ts";
import { boundedDiagnostic, failureLayer, inspectGuest, safeExternalResponse } from "./health.ts";

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
}

/** Starts an isolated template copy, or takes ownership of this run's freshly prepared VM. */
export async function launchDaytonaEvidenceWorld(template: DaytonaEvidenceLaunch, sourceSha: string, api = new DaytonaApi(), options: CdpWaitOptions = {}): Promise<DaytonaEvidenceSession> {
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
    // The preview proxy dials localhost inside the VM; a boot with an empty /etc/hosts answers 502 on every
    // port. Best effort and bounded: saved layers are already repaired, and the CDP wait reports any failure.
    await Promise.race([api.exec(sandbox, LOCALHOST_RECIPE, 15).catch(() => undefined), delay(20_000, undefined, { ref: false })]).catch(() => undefined);
    const [viewer, cdp] = await Promise.all([api.previewUrl(sandbox.id, 8080), api.previewUrl(sandbox.id, 8081)]);
    credentials.add(viewer.token); credentials.add(cdp.token);
    const token = randomBytes(32).toString("base64url");
    credentials.add(token);
    const expiresAt = new Date(Date.now() + WORLD_MINUTES * 60_000).toISOString();
    // No origins: each gateway forwards to its one pinned service (see GATEWAY_UNITS).
    await api.writeFile(sandbox, ACCESS_FILE, JSON.stringify({ sandboxId: sandbox.id, sourceSha, token, expiresAt }), 0o600);
    const session: DaytonaEvidenceSession = { id: sandbox.id, sourceSha, cookie: `__Host-openwork-preview=${token}`, expiresAt,
      viewer: { url: viewer.url, previewToken: viewer.token }, cdp: { url: cdp.url, previewToken: cdp.token } };
    await waitForCdp(session, { ...options, secrets: [...credentials] });
    return session;
  } catch (error) {
    if (!owned) throw error;
    // Persist the safe external facts before a toolbox call can stall. This
    // synchronous fallback also survives failure of a caller's diagnostic sink.
    const external = error instanceof CdpReadinessError ? error.history : [];
    const publicResource = (value: string | undefined, pattern: RegExp) => value && pattern.test(value)
      && ![...credentials].some((secret) => secret.length > 0 && value.toLowerCase().includes(secret.toLowerCase())) ? value : undefined;
    const context = { sourceSha,
      sandboxId: publicResource(created.id, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/),
      parentSnapshot: publicResource(diagnosticSandbox.snapshot, /^ow-dy-evidence-(?:image|web)-v1-[a-f0-9]{40}$/) };
    try { console.error(JSON.stringify({ stage: "daytona-evidence-external", ...context, external })); }
    catch { /* A broken log sink must not mask the original failure or skip teardown. */ }
    // Collect while the owned VM still exists. Never publish the error text,
    // URLs, access file, service environment, or unfiltered guest logs.
    await boundedDiagnostic(async () => {
      const health = await inspectGuest(api, diagnosticSandbox).catch(() => undefined);
      const status = external.at(-1)?.status ?? 0;
      const summary = JSON.stringify({ stage: "daytona-evidence-launch", ...context, at: new Date().toISOString(), layer: external.length > 0 ? failureLayer(health, status, external.at(-1)?.body) : "unresolved", external, health: health ?? "unavailable" });
      if (options.diagnostic) await options.diagnostic(summary);
      else console.error(summary);
    }, options.diagnosticTimeoutMs);
    await api.deleteSandbox(created.id).catch(() => undefined);
    throw error;
  }
}

export class CdpReadinessError extends Error {
  readonly history: ReturnType<typeof safeExternalResponse>[];
  constructor(history: ReturnType<typeof safeExternalResponse>[]) {
    super(`The evidence browser did not answer (HTTP ${history.at(-1)?.status ?? 0})`);
    this.history = history;
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

/** The resumed browser answers through both access checks; auth errors are not boot delays. */
export async function waitForCdp(session: DaytonaEvidenceSession, options: CdpWaitOptions = {}) {
  const history: ReturnType<typeof safeExternalResponse>[] = [];
  const probe = options.probe ?? fetch;
  const secrets = [...(options.secrets ?? []), session.cdp.previewToken, session.cookie, session.cookie.slice(session.cookie.indexOf("=") + 1)];
  const attempts = options.attempts ?? 60;
  const deadline = Date.now() + 70_000;
  for (let attempt = 0; attempt < attempts && Date.now() < deadline; attempt++) {
    let status = 0;
    try {
      const response = await probe(`${session.cdp.url}/json/version`, { headers: { cookie: session.cookie, "x-daytona-preview-token": session.cdp.previewToken, "x-daytona-skip-preview-warning": "true" }, signal: AbortSignal.timeout(Math.min(10_000, deadline - Date.now())) });
      status = response.status;
      const body = await boundedBody(response).catch(() => "");
      history.push(safeExternalResponse(status, response.headers, body, secrets));
      if (response.ok) {
        try {
          const version: unknown = JSON.parse(body);
          if (typeof version === "object" && version !== null && "Browser" in version && "webSocketDebuggerUrl" in version
            && typeof version.Browser === "string" && typeof version.webSocketDebuggerUrl === "string") return;
        } catch { /* A 200 HTML/error page is not a live CDP endpoint. */ }
      }
    } catch { history.push(safeExternalResponse(0, new Headers(), "")); }
    if (history.length > 8) history.shift();
    if ([401, 403].includes(status)) break;
    if (attempt + 1 < attempts && Date.now() < deadline) await delay(options.pauseMs ?? 1_000);
  }
  throw new CdpReadinessError(history);
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
