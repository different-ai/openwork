import { loopbackFetch } from "./server-fetch.js";

/**
 * The v1 engine sets a folder up (config, plugins, provider catalog) on the
 * first request that names it, and every other first request for that folder
 * waits on the same setup. Measured on desktop launches, that setup took
 * 4.7–5.9 s when the window's first reads triggered it, and 0.18 s when the
 * server asked before the window was ready. Asking early takes that wait off
 * the model picker.
 */
export const ENGINE_FOLDER_WARMUP_TIMEOUT_MS = 15_000;

export type EngineFolderWarmupTarget = {
  baseUrl: string;
  authHeader?: string;
};

export type EngineFolderWarmupResult =
  | { ok: true; durationMs: number }
  | { ok: false; durationMs: number; status?: number; error?: string };

/**
 * Set a folder up on the engine by reading its connected providers, the
 * cheapest read that loads both the folder and its provider state (~30 KB).
 * Never throws: warming is an optimisation, and a failure leaves the folder
 * to be set up on the first real request, as before.
 */
export async function warmEngineFolder(input: {
  target: EngineFolderWarmupTarget;
  directory: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof loopbackFetch;
  now?: () => number;
}): Promise<EngineFolderWarmupResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const durationMs = () => Math.max(0, now() - startedAt);
  const fetchImpl = input.fetchImpl ?? loopbackFetch;
  try {
    const url = new URL(input.target.baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/config/providers`;
    url.search = "";
    url.searchParams.set("directory", input.directory);
    const timeout = AbortSignal.timeout(input.timeoutMs ?? ENGINE_FOLDER_WARMUP_TIMEOUT_MS);
    const response = await fetchImpl(url, {
      method: "GET",
      headers: input.target.authHeader ? { Authorization: input.target.authHeader } : {},
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
    });
    // Drain the body so the connection is released; the content is not needed.
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) return { ok: false, durationMs: durationMs(), status: response.status };
    return { ok: true, durationMs: durationMs() };
  } catch (error) {
    return { ok: false, durationMs: durationMs(), error: error instanceof Error ? error.message : String(error) };
  }
}
