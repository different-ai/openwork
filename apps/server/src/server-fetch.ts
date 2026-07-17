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
