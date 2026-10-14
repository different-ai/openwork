import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DaytonaApi, type Sandbox } from "./api.ts";
import type { DaytonaEvidenceLaunch } from "./builder.ts";

import { COPY_KIND, EVIDENCE_KIND } from "./kinds.ts";

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

/** Starts an isolated template copy, or takes ownership of this run's freshly prepared VM. */
export async function launchDaytonaEvidenceWorld(template: DaytonaEvidenceLaunch, sourceSha: string, api = new DaytonaApi(), previewOwner?: string): Promise<DaytonaEvidenceSession> {
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !/^[a-f0-9]{40}$/.test(template.runtimeFingerprint)) throw new Error("Full source SHA and runtime fingerprint required");
  if ("sandbox" in template && (template.sandbox.labels.kind !== EVIDENCE_KIND || template.sandbox.labels.sourceSha !== sourceSha)) {
    throw new Error("Refusing to adopt an unrelated prepared world");
  }
  const name = `ow-dy-evidence-${randomUUID().replaceAll("-", "")}`;
  const created = "sandbox" in template ? template.sandbox : await api.createSandbox({ name, snapshot: template.name,
    labels: { kind: EVIDENCE_KIND, sourceSha, ...(previewOwner ? { previewOwner, previewSource: name } : {}) }, autoStopMinutes: IDLE_STOP_MINUTES, autoDeleteMinutes: 0 });
  try {
    const sandbox = await api.waitForSandbox(created.id, ["started"]);
    if ("sandbox" in template && (sandbox.labels.kind !== EVIDENCE_KIND || sandbox.labels.sourceSha !== sourceSha
      || (await api.readFile(sandbox, `${ROOT}/built-from-sha`))?.trim() !== sourceSha)) throw new Error("Prepared world source mismatch");
    // A template may serve several commits whose VM-side files are identical.
    if ((await api.readFile(sandbox, `${ROOT}/evidence-ready`))?.trim() !== "web-v1"
      || (await api.readFile(sandbox, `${ROOT}/runtime-fingerprint`))?.trim() !== template.runtimeFingerprint) throw new Error("Evidence world source mismatch");
    const [viewer, cdp] = await Promise.all([api.previewUrl(sandbox.id, 8080), api.previewUrl(sandbox.id, 8081)]);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + WORLD_MINUTES * 60_000).toISOString();
    // No origins: each gateway forwards to its one pinned service (see GATEWAY_UNITS).
    await api.writeFile(sandbox, ACCESS_FILE, JSON.stringify({ sandboxId: sandbox.id, sourceSha, token, expiresAt }), 0o600);
    const session: DaytonaEvidenceSession = { id: sandbox.id, sourceSha, cookie: `__Host-openwork-preview=${token}`, expiresAt,
      viewer: { url: viewer.url, previewToken: viewer.token }, cdp: { url: cdp.url, previewToken: cdp.token } };
    await waitForCdp(session);
    return session;
  } catch (error) {
    if (previewOwner) await diagnoseCoreBrowser(api, created).catch(() => console.warn("Core browser diagnostics unavailable; launch still fails."));
    await api.deleteSandbox(created.id).catch(() => undefined);
    throw error;
  }
}

/** Only fixed service states and HTTP status codes: no logs, URLs or credentials. */
async function diagnoseCoreBrowser(api: DaytonaApi, sandbox: Sandbox): Promise<void> {
  const code = `const { readFile } = await import('node:fs/promises');
const services = JSON.parse(await readFile('/opt/openwork-preview/services.json', 'utf8'));
const cdp = new URL(services.cdp);
if (cdp.protocol !== 'http:' || cdp.hostname !== '127.0.0.1') throw new Error('Invalid local CDP');
const access = JSON.parse(await readFile('/opt/openwork-preview/access.json', 'utf8'));
const results = {};
for (const [name, url, headers] of [
  ['browser', new URL('/json/version', cdp), {}],
  ['gateway', 'http://127.0.0.1:8081/json/version', { cookie: '__Host-openwork-preview=' + access.token }],
]) {
  try { results[name] = (await fetch(url, { headers, signal: AbortSignal.timeout(3000) })).status; }
  catch { results[name] = 'unreachable'; }
}
console.log(JSON.stringify(results));`;
  const probe = await api.exec(sandbox, `node --input-type=module -e ${JSON.stringify(code)}`, 15);
  const health: unknown = JSON.parse(probe.output);
  if (typeof health !== "object" || health === null || !("browser" in health) || !("gateway" in health)) throw new Error("Invalid browser health probe");
  const status = (value: unknown) => value === "unreachable" || (typeof value === "number" && value >= 100 && value <= 599);
  if (!status(health.browser) || !status(health.gateway)) throw new Error("Invalid browser health status");
  console.warn(JSON.stringify({ stage: "core-browser-health", browser: health.browser, gateway: health.gateway }));
}

/** The resumed browser answers through both access checks. */
async function waitForCdp(session: DaytonaEvidenceSession, probe: typeof fetch = fetch) {
  let status = 0;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await probe(`${session.cdp.url}/json/version`, { headers: { cookie: session.cookie, "x-daytona-preview-token": session.cdp.previewToken, "x-daytona-skip-preview-warning": "true" }, signal: AbortSignal.timeout(10_000) });
      status = response.status;
      if (response.ok) return;
    } catch { status = 0; }
    await delay(1_000);
  }
  throw new Error(`The evidence browser did not answer (HTTP ${status})`);
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
