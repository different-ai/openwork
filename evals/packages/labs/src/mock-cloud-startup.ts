/** Browser-only, opt-in faults for the hosted startup journey. No fault is
 * active during the real cold-boot measurement. Reload discards pending reads. */
export function installCloudStartupFaults() {
  const originalFetch = window.fetch.bind(window);
  async function holdBody(response: Response, mode: string) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const deadline = Date.now() + 70_000;
    // Deliver real headers immediately and hold the response body until the
    // test releases the gate. This avoids racing a short-lived loading label
    // against CDP round trips, and does not disable production request timers.
    const body = new ReadableStream({
      start(controller) {
        const timer = setInterval(() => {
          if (sessionStorage.getItem("eval.cloud-startup-fault") === mode && Date.now() < deadline) return;
          clearInterval(timer);
          controller.enqueue(bytes);
          controller.close();
        }, 100);
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  window.fetch = async (input, init) => {
    const mode = sessionStorage.getItem("eval.cloud-startup-fault");
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (mode && url.origin === location.origin) {
      if (mode === "access" && url.pathname.endsWith("/v1/billing/web")) {
        return holdBody(await originalFetch(input, init), mode);
      }
      if (url.pathname.endsWith("/v1/cloud/instance") && (mode === "waking" || mode === "failed")) {
        return Response.json({ status: mode, url: null });
      }
      // Keep the real instance ready while its workspace response is delayed.
      // This tests the distinct connection phase without falsifying boot time.
      if (mode === "connecting" && ["/workspaces", "/workspace/", "/w/", "/opencode/"].some((prefix) => url.pathname.startsWith(prefix))) {
        return holdBody(await originalFetch(input, init), mode);
      }
    }
    return originalFetch(input, init);
  };
}
