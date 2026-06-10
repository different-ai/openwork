/**
 * @param {unknown} urlInput
 * @param {any} [initInput]
 * @param {typeof fetch} [fetchImpl]
 */
export async function desktopFetch(urlInput, initInput = {}, fetchImpl = fetch) {
  const url = String(urlInput ?? "").trim();
  const init = /** @type {any} */ (initInput && typeof initInput === "object" ? initInput : {});
  if (!url) throw new Error("URL is required.");

  const timeoutMs = Number(init.timeoutMs);
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.max(1, Math.floor(timeoutMs))
    : null;
  const controller = timeout ? new AbortController() : null;
  const timer = timeout && controller ? setTimeout(() => controller.abort(), timeout) : null;
  const signal = controller?.signal;
  let response;
  try {
    response = await fetchImpl(url, {
      method: typeof init.method === "string" ? init.method : undefined,
      headers: init.headers && typeof init.headers === "object" ? init.headers : undefined,
      body: typeof init.body === "string" ? init.body : undefined,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new Error(`Fetch timed out after ${timeout}ms`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
    body: await response.text(),
  };
}
