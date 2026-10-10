import { addInitScript, evaluate, type Surface } from "@openwork/cdp";

export function activityApiTimings(log: string) {
  return log.split("\n").flatMap((line) => {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { return []; }
    if (typeof entry !== "object" || entry === null || !("http_route" in entry) || !("duration_ms" in entry)
      || !("http_method" in entry) || entry.http_method !== "GET" || !("http_status_code" in entry)
      || typeof entry.http_route !== "string" || typeof entry.duration_ms !== "number" || typeof entry.http_status_code !== "number"
      || !/^\/v1\/(plugins|marketplaces|config-objects|mcp-connections|llm-providers|inference-providers)(\/|$)/.test(entry.http_route)) return [];
    return [{ route: entry.http_route, durationMs: entry.duration_ms, status: entry.http_status_code }];
  });
}

/** Observe DOM readiness and browser request timings; never write app data/cache. */
export async function activityTiming(web: Surface) {
  await addInitScript(web.client, () => {
    performance.setResourceTimingBufferSize(2000);
    let state = "";
    new MutationObserver(() => {
      const next = document.querySelector('[data-testid="dashboard-activity-loading"]') ? "loading"
        : document.querySelector('[data-testid="dashboard-activity-row"]') ? "rows" : "";
      if (next && next !== state) performance.mark("activity-" + next);
      state = next;
    }).observe(document, { childList: true, subtree: true });
  });
  return async () => evaluate(web.client, () => {
    const loading = performance.getEntriesByName("activity-loading")[0]?.startTime ?? null;
    const rows = performance.getEntriesByName("activity-rows")[0]?.startTime ?? null;
    const requests = performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/api/browser/v1/"))
      .map((entry) => ({
        // No host, cookies, headers, query values, or workspace identities.
        route: new URL(entry.name).pathname.replace(/\/(plg|cob|mkt|emc)_[^/]+/g, "/:id"),
        startMs: Math.round(entry.startTime), durationMs: Math.round(entry.duration), endMs: Math.round(entry.startTime + entry.duration),
      }));
    return {
      timeOrigin: performance.timeOrigin,
      observedAtMs: performance.now(),
      loadingStarts: performance.getEntriesByName("activity-loading").map((entry) => entry.startTime),
      loadingMs: loading === null || rows === null ? null : Math.round(rows - loading),
      rowsAtMs: rows === null ? null : Math.round(rows),
      versionReads: requests.filter((entry) => entry.route.endsWith("/versions")).length,
      requests,
    };
  });
}
