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
  }
  return globalFetch;
}

export function externalFetch(input: string, init?: RequestInit): Promise<Response> {
  externalFetchPromise ??= resolveExternalFetch();
  return externalFetchPromise.then((resolvedFetch) => resolvedFetch(input, init));
}

export function loopbackFetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
): ReturnType<typeof globalThis.fetch> {
  return globalThis.fetch(input, init);
}

export function transferResponseBody(response: Response): ReadableStream<Uint8Array> | null {
  return response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>()) ?? null;
}

export type RuntimeDiagnosticRuntimeFamily = "electron-node" | "node" | "bun" | "unknown";
export type RuntimeDiagnosticTransport = "node-undici" | "bun-fetch" | "test-seam" | "unknown";

export type RuntimeDiagnosticTransportInfo = {
  runtimeFamily: RuntimeDiagnosticRuntimeFamily;
  transport: RuntimeDiagnosticTransport;
};

export function runtimeDiagnosticTransportInfo(): RuntimeDiagnosticTransportInfo {
  const versions: Record<string, string | undefined> = process.versions;
  if (versions.bun) return { runtimeFamily: "bun", transport: "bun-fetch" };
  if (versions.electron && versions.node) return { runtimeFamily: "electron-node", transport: "node-undici" };
  if (versions.node) return { runtimeFamily: "node", transport: "node-undici" };
  return { runtimeFamily: "unknown", transport: "unknown" };
}

export function runtimeDiagnosticFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}
