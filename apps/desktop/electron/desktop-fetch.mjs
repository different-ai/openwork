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
  const externalSignal = init.signal && typeof init.signal === "object" && typeof init.signal.addEventListener === "function"
    ? init.signal
    : null;
  let timedOut = false;
  const timer = timeout && controller ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout) : null;
  let removeExternalAbort = null;
  if (controller && externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      removeExternalAbort = () => controller.abort(externalSignal.reason);
      externalSignal.addEventListener("abort", removeExternalAbort, { once: true });
    }
  }
  const signal = controller?.signal ?? externalSignal ?? undefined;
  const body = Object.prototype.hasOwnProperty.call(init, "body") ? init.body : undefined;
  let response;
  try {
    response = await fetchImpl(url, {
      method: typeof init.method === "string" ? init.method : undefined,
      redirect: "manual",
      headers: init.headers && typeof init.headers === "object" ? init.headers : undefined,
      body,
      signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new Error(`Fetch timed out after ${timeout}ms`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (externalSignal && removeExternalAbort) {
      externalSignal.removeEventListener("abort", removeExternalAbort);
    }
  }
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
    body: await response.text(),
  };
}
