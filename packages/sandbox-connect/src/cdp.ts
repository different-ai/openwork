import { connectSandboxPort, type ConnectOptions, type Readiness, type SandboxConnection } from "./connect.ts";
import type { RouteSummary, SandboxRoute } from "./routes.ts";

export interface CdpProbe { route: RouteSummary; status: number; headers: Headers; body: string }

async function boundedText(response: Response, limit = 8_192) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < limit) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value.subarray(0, limit - bytes);
      chunks.push(chunk); bytes += chunk.length;
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks).toString("utf8");
}

/** A live DevTools endpoint answers /json/version with a browser and a WebSocket URL. */
export function isCdpVersion(body: string) {
  try {
    const version: unknown = JSON.parse(body);
    return typeof version === "object" && version !== null && "Browser" in version && "webSocketDebuggerUrl" in version
      && typeof version.Browser === "string" && typeof version.webSocketDebuggerUrl === "string";
  } catch { return false; }
}

export interface CdpConnectOptions extends Omit<ConnectOptions, "check"> {
  /** Sees every probe, e.g. to record safe diagnostics. Must not log bodies or headers verbatim. */
  onProbe?: (probe: CdpProbe) => void;
}

/**
 * Connects to a sandboxed browser's remote-control port over whichever route
 * answers first. The returned URL is plain loopback CDP: Playwright, puppeteer
 * and @openwork/cdp attach to it unchanged.
 */
export function connectSandboxCdp(routes: readonly SandboxRoute[], options: CdpConnectOptions = {}): Promise<SandboxConnection> {
  const { onProbe, ...rest } = options;
  return connectSandboxPort(routes, { ...rest, async check(url, route, signal): Promise<Readiness> {
    let response: Response;
    try { response = await fetch(`${url}/json/version`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }); }
    catch { onProbe?.({ route, status: 0, headers: new Headers(), body: "" }); return "retry"; }
    const body = await boundedText(response).catch(() => "");
    onProbe?.({ route, status: response.status, headers: response.headers, body });
    if (response.ok && isCdpVersion(body)) return "ready";
    // Wrong credentials never become right by waiting.
    return [401, 403].includes(response.status) ? "fail" : "retry";
  } });
}
