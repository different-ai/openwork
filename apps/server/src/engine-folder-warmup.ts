import { loopbackFetch } from "./server-fetch.js";

export const ENGINE_FOLDER_WARMUP_TIMEOUT_MS = 15_000;

export type EngineFolderWarmupTarget = {
  baseUrl: string;
  authHeader?: string;
};

export type EngineFolderWarmupResult =
  | { ok: true; durationMs: number }
  | { ok: false; durationMs: number; status?: number; error?: string };

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
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) return { ok: false, durationMs: durationMs(), status: response.status };
    return { ok: true, durationMs: durationMs() };
  } catch (error) {
    return { ok: false, durationMs: durationMs(), error: error instanceof Error ? error.message : String(error) };
  }
}
