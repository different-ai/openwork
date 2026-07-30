type ExternalFetch = (input: string, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function globalFetch(input: string, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

function hasElectronNetFetch(value: unknown): value is { net: { fetch: ExternalFetch } } {
  return isRecord(value) && isRecord(value.net) && typeof value.net.fetch === "function";
}

let externalFetchPromise: Promise<ExternalFetch> | undefined;

async function resolveExternalFetch(): Promise<ExternalFetch> {
  if (!process.versions.electron) return globalFetch;
  try {
    const moduleName = "electron";
    const mod: unknown = await import(moduleName);
    if (hasElectronNetFetch(mod)) {
      const { net } = mod;
      return (input, init) => net.fetch(input, init);
    }
  } catch {
    // Electron is optional when the server runs standalone or under tests.
  }
  return globalFetch;
}

export function externalFetch(input: string, init?: RequestInit): Promise<Response> {
  externalFetchPromise ??= resolveExternalFetch();
  return externalFetchPromise.then((resolvedFetch) => resolvedFetch(input, init));
}

/**
 * Rule: external egress → externalFetch; loopback → loopbackFetch; bare fetch is banned in apps/server/src.
 * Use loopbackFetch only for 127.0.0.1, localhost, and managed OpenCode engine traffic where CA trust is irrelevant and streaming performance matters.
 */
export function loopbackFetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
): ReturnType<typeof globalThis.fetch> {
  return globalThis.fetch(input, init);
}

export type RuntimeDiagnosticRuntimeFamily = "electron-node" | "node" | "bun" | "unknown";
export type RuntimeDiagnosticTransport = "node-undici" | "bun-fetch" | "test-seam" | "unknown";

export type RuntimeDiagnosticTransportInfo = {
  runtimeFamily: RuntimeDiagnosticRuntimeFamily;
  transport: RuntimeDiagnosticTransport;
};

/**
 * Identifies the JavaScript runtime and fetch transport behind
 * runtimeDiagnosticFetch, so a diagnostic can attribute its own egress path
 * instead of implying it exercised Chromium networking or the OpenCode engine.
 */
export function runtimeDiagnosticTransportInfo(): RuntimeDiagnosticTransportInfo {
  const versions: Record<string, string | undefined> = process.versions;
  if (versions.bun) return { runtimeFamily: "bun", transport: "bun-fetch" };
  if (versions.electron && versions.node) return { runtimeFamily: "electron-node", transport: "node-undici" };
  if (versions.node) return { runtimeFamily: "node", transport: "node-undici" };
  return { runtimeFamily: "unknown", transport: "unknown" };
}

/**
 * Deliberate runtime-diagnostic egress. Unlike externalFetch, this must stay
 * on the embedding JavaScript runtime's own fetch stack (Node/undici inside
 * Electron main and standalone Node, Bun's fetch in the compiled binary) and
 * must never route through Chromium's electronNet or the OpenCode engine —
 * that independence is what lets diagnostics compare the OpenWork runtime's
 * network path against the engine's report. Pair every use with
 * runtimeDiagnosticTransportInfo so reports state which stack actually ran.
 */
export function runtimeDiagnosticFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}
