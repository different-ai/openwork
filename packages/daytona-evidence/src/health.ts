import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { DaytonaApi, Sandbox } from "./api.ts";

const script = readFileSync(new URL("./guest-health.mjs", import.meta.url), "utf8");
export const guestHealthCommand = (prepare = false) => `${prepare ? "OPENWORK_DAYTONA_HEALTH_PREPARE=1 " : ""}node --input-type=module -e '${script.replaceAll("'", "'\\''")}'`;
const unitNames = ["openwork-evidence", "openwork-evidence-cdp", "openwork-evidence-gateway"];
const eventNames = ["refused", "addressInUse", "oom", "crash", "exited"];
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
const object = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
const integer = (value: unknown, max = 65_535) => typeof value === "number" && Number.isInteger(value) && value >= -1 && value <= max ? value : -1;
const choice = (value: unknown, allowed: string[]) => typeof value === "string" && allowed.includes(value) ? value : "unknown";
const events = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && eventNames.includes(item)).slice(0, 5) : [];
const probe = (value: unknown) => { const data = object(value); return { status: integer(data.status, 599), cdp: data.cdp === true }; };

/** Rebuild the allowlisted shape; never trust or publish arbitrary guest stdout. */
export function parseGuestHealth(raw: string) {
  const data = object(JSON.parse(raw));
  const list = (value: unknown) => Array.isArray(value) ? value.slice(0, 3).map(object).filter((item) => unitNames.includes(String(item.name))) : [];
  return { chrome: probe(data.chrome), gateway: probe(data.gateway), chromePort: integer(data.chromePort), upstreamPort: integer(data.upstreamPort),
    listeners: Array.isArray(data.listeners) ? data.listeners.map((value) => integer(value)).filter((port) => port > 0).slice(0, 4) : [],
    units: list(data.units).map((unit) => ({ name: choice(unit.name, unitNames), active: choice(unit.active, ["active", "inactive", "failed", "activating", "deactivating"]),
      sub: choice(unit.sub, ["running", "dead", "failed", "start", "stop", "exited"]), result: choice(unit.result, ["success", "exit-code", "signal", "core-dump", "oom-kill", "timeout"]), exit: integer(unit.exit) })),
    journals: list(data.journals).map((unit) => ({ name: choice(unit.name, unitNames), events: events(unit.events) })),
    browserEvents: events(data.browserEvents), kernelEvents: events(data.kernelEvents), oomKills: integer(data.oomKills, Number.MAX_SAFE_INTEGER) };
}
export type GuestHealth = ReturnType<typeof parseGuestHealth>;
export function localEvidenceReady(health: GuestHealth) {
  return health.chrome.status === 200 && health.chrome.cdp && health.gateway.status === 200 && health.gateway.cdp
    && health.chromePort > 0 && health.chromePort === health.upstreamPort;
}
export async function inspectGuest(api: DaytonaApi, sandbox: Sandbox, prepare = false) {
  return parseGuestHealth(await api.execChecked(sandbox, guestHealthCommand(prepare), 10));
}

/** Markers and systemctl start can outlive Chrome. Preparation must prove the live route. */
export async function requireLocalEvidenceReady(api: DaytonaApi, sandbox: Sandbox, attempts = 15, pauseMs = 1_000) {
  let health: GuestHealth | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    health = await inspectGuest(api, sandbox, true);
    if (localEvidenceReady(health)) return;
    if (attempt + 1 < attempts) await delay(pauseMs);
  }
  throw new Error(`Daytona evidence local readiness failed: ${JSON.stringify(health)}`);
}

export const GATEWAY_UNAVAILABLE_BODY = "Sandbox unavailable. Launch a fresh sandbox from the review.";

export function failureLayer(health: GuestHealth | undefined, externalStatus: number, externalBody?: string) {
  if ([401, 403].includes(externalStatus)) return "external-access";
  if (!health || health.chrome.status < 0 || health.chromePort <= 0) return "unresolved";
  if (health.chrome.status !== 200 || !health.chrome.cdp) return "chrome-startup-or-crash";
  if (health.gateway.status < 0) return "unresolved";
  if (health.gateway.status !== 200 || !health.gateway.cdp) return "guest-gateway-or-stale-port";
  if (health.upstreamPort <= 0) return "unresolved";
  if (health.chromePort !== health.upstreamPort) return "guest-gateway-or-stale-port";
  // A fixed guest error body contradicts blaming the provider merely because
  // the internal endpoints recovered before this post-failure inspection.
  if (externalStatus === 502 && externalBody === GATEWAY_UNAVAILABLE_BODY) return "guest-upstream-at-external-probe";
  return externalStatus === 502 ? "provider-preview-route" : "external-preview-route";
}

/** Fixed bodies only. Unknown private prose is represented by size, never a redacted guess. */
export function safeExternalResponse(status: number, headers: Headers, body: string, secrets: readonly string[] = []) {
  const containsSecret = (value: string) => secrets.some((secret) => secret.length > 0 && value.toLowerCase().includes(secret.toLowerCase()));
  const known = [GATEWAY_UNAVAILABLE_BODY,
    "Open this sandbox from your review launch link. If it has expired, launch a fresh sandbox.", "Use this sandbox's own service URLs."];
  const selected: Record<string, string> = {};
  for (const name of ["content-type", "server", "via", "cf-ray", "x-request-id"]) {
    const value = headers.get(name);
    if (!value || containsSecret(value)) continue;
    // Only known header grammars/values, not cookies, redirects or arbitrary echoed text.
    if (name === "content-type" && /^(application\/json|text\/(plain|html))(; charset=utf-8)?$/i.test(value)) selected[name] = value.toLowerCase();
    if (name === "server" && /^(nginx|envoy|cloudflare|daytona)$/i.test(value)) selected[name] = value.toLowerCase();
    if (["cf-ray", "x-request-id"].includes(name) && /^[a-f0-9-]{8,64}(?:-[A-Z]{3})?$/.test(value)) selected[name] = value;
    if (name === "via" && /^[12](?:\.\d)? (envoy|nginx)$/.test(value)) selected[name] = value;
  }
  return { status, at: new Date().toISOString(), headers: selected, body: known.includes(body.trim()) && !containsSecret(body) ? body.trim() : "[private body omitted]", bodyBytes: Buffer.byteLength(body) };
}

/** Bounds diagnostics even if the toolbox or a diagnostic sink stops answering. */
export async function boundedDiagnostic(work: () => Promise<void>, timeoutMs = 15_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(work), new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  } catch { /* Diagnostics must not replace the original failure or prevent cleanup. */ }
  finally { if (timer) clearTimeout(timer); }
}
