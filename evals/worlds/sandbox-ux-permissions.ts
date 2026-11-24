import { execFile } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { browserScript, evaluateOnSurface, type AttachedSurface } from "@openwork/cdp";

const lock = "/tmp/ow-e2e-lock";
export async function acquirePermissionsMachine(owner: string) {
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const age = await stat(lock).then(info => Date.now() - info.mtimeMs, () => 0);
      if (age > 45 * 60_000) await rm(lock, { recursive: true, force: true });
      await delay(5_000);
    }
  }
  const release = () => rm(lock, { recursive: true, force: true });
  try { await writeFile(`${lock}/owner`, `${owner}\n`); }
  catch (error) { await release(); throw error; }
  return release;
}

/** Only return PID, parent and executable basename, never arguments or environment. */
export async function permissionsDescendants(owner: number | undefined) {
  if (!owner) throw new Error("Missing owned desktop PID");
  const { stdout } = await promisify(execFile)("/bin/ps", ["-axo", "pid=,ppid=,comm="]);
  const rows = stdout.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), executable: match[3]?.split("/").at(-1) ?? "" }] : [];
  });
  const parents = new Map(rows.map(row => [row.pid, row.parent]));
  return rows.filter(row => {
    for (let p: number | undefined = row.parent, hops = 0; p !== undefined && hops < 64; p = parents.get(p), hops++) if (p === owner) return true;
    return false;
  });
}

type PermissionsCapture = {
  t: number; epoch: number;
  marks: Record<string, number>;
  notices: Record<string, { start: number; last: number; end: number | null }[]>;
  resources: { name: string; startTime: number; duration: number; responseEnd: number; serverTiming: { name: string; duration: number }[] }[];
  performanceMarks: Record<string, number | null>;
};
export async function pollPermissions(surface: AttachedSurface, options: { modes: boolean; expectSwitch: boolean; captureMs: number; limitMs: number }) {
  const captureStarted = performance.now();
  await evaluateOnSurface(surface, browserScript(({ modes, expectSwitch, captureMs, limitMs }) => {
    Reflect.deleteProperty(window, "__permissionsCapture");
    void (async (): Promise<PermissionsCapture> => {
      performance.setResourceTimingBufferSize(4000);
      performance.clearResourceTimings();
      const t = performance.now();
      const epoch = performance.timeOrigin + t;
      const marks: Record<string, number> = {};
      const notices: Record<string, { start: number; last: number; end: number | null }[]> = {};
      const active = new Map<string, { start: number; last: number; end: number | null }>();
      const visible = (el: Element | null) => Boolean(el?.getClientRects().length && getComputedStyle(el).visibility !== "hidden");
      const enabled = (el: Element | null) => visible(el) && !el?.matches(':disabled,[aria-disabled="true"],[data-disabled]');
      const selector = (id: string) => `[data-testid="${id}"]`;
      do {
        const now = performance.now() - t;
        const section = [...document.querySelectorAll('h1,h2,h3,h4,[role="heading"],p,span,div')].find(el => visible(el) && !el.children.length && el.textContent?.trim() === "Authorized folders");
        const folders = document.querySelector(`${selector("authorized-folders-panel")}[data-ready="true"]`);
        const sandbox = document.querySelector(`${selector("sandbox-panel")}[data-ready="true"]`);
        const add = [...document.querySelectorAll('button,[role="button"]')].find(el => enabled(el) && el.textContent?.trim() === "Add folder");
        const toggle = document.querySelector(selector(modes ? "sandbox-use-switch" : "host-execution-switch"));
        const force = document.querySelector(selector("sandbox-force-switch"));
        const retry = [...document.querySelectorAll(`${selector("sandbox-panel")} button`)].find(el => enabled(el) && el.textContent?.trim() === "Retry");
        if (section) marks["heading-visible"] ??= now;
        if (folders) marks["folders-ready"] ??= now;
        if (sandbox) marks["sandbox-ready"] ??= now;
        if (add) marks["add-enabled"] ??= now;
        if (visible(toggle)) marks["switch-visible"] ??= now;
        if (enabled(toggle)) marks["switch-enabled"] ??= now;
        if (enabled(force)) marks["force-enabled"] ??= now;
        if (retry) marks["sandbox-retry-enabled"] ??= now;
        const settingsError = retry?.parentElement?.innerText?.includes("Couldn't load sandbox settings.");
        if (settingsError) marks["sandbox-settings-error-with-retry"] ??= now;
        if (add && (!modes || (folders && sandbox)) && (!expectSwitch || enabled(toggle))) marks.tti ??= now;
        const lines = new Set(document.body.innerText.split("\n").map(text => text.trim()).filter(line => /loading|checking|pulling in|disconnected|starting|failed|unable|error|retry|unavailable|couldn.t/i.test(line)));
        for (const line of lines) {
          const prior = active.get(line);
          if (prior) prior.last = now;
          else {
            const interval = { start: now, last: now, end: null };
            (notices[line] ??= []).push(interval);
            active.set(line, interval);
          }
        }
        for (const [line, interval] of active) if (!lines.has(line)) { interval.end = now; active.delete(line); }
        if (now >= captureMs && (marks.tti !== undefined || marks["sandbox-settings-error-with-retry"] !== undefined)) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (performance.now() - t < limitMs);
      const resources = performance.getEntriesByType("resource").flatMap(entry => {
        if (!(entry instanceof PerformanceResourceTiming) || !/^http:\/\/(127\.0\.0\.1|localhost):/.test(entry.name)) return [];
        const url = new URL(entry.name);
        if (entry.startTime < t) return [];
        return [{ name: url.origin + url.pathname, startTime: entry.startTime, duration: entry.duration, responseEnd: entry.responseEnd, serverTiming: entry.serverTiming.map(({ name, duration }) => ({ name, duration })) }];
      });
      const mark = (name: string) => performance.getEntriesByName(`openwork:permissions:${name}`, "mark").find(entry => entry.startTime >= t)?.startTime;
      const route = mark("route-start");
      const relative = (name: string) => { const at = mark(name); return route !== undefined && at !== undefined ? at - route : null; };
      return { t, epoch, marks, notices, resources, performanceMarks: { "route-start": route === undefined ? null : route - t, "folders-ready": relative("folders-ready"), "sandbox-ready": relative("sandbox-ready") } };
    })().then(result => Reflect.set(window, "__permissionsCapture", result), () => Reflect.set(window, "__permissionsCapture", "failed"));
  }, [options]));
  // Keep each CDP call short; the transport can cap Runtime.evaluate at 8 s.
  while (performance.now() - captureStarted < options.limitMs + 3_000) {
    const result = await evaluateOnSurface(surface, (): PermissionsCapture | "failed" | undefined => Reflect.get(window, "__permissionsCapture"));
    if (result === "failed") throw new Error("Renderer permissions capture failed");
    if (result) return result;
    await delay(250);
  }
  throw new Error("Renderer permissions capture did not finish");
}

/** Passive capture only. No GETs injected while observing whether the product retries. */
export async function installPermissionsFetchTrace(surface: AttachedSurface) {
  await evaluateOnSurface(surface, () => {
    const upstream = globalThis.fetch;
    const rows: { path: string; start: number; end?: number; status?: number; serverTiming?: string | null; outcome?: string; verification?: string; featureEnabled?: boolean; pending?: boolean }[] = [];
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      const result = upstream(input, init);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !/\/(sandbox-settings|sandbox-status|authorized-folders|health|workspaces|v1\/me|v1\/org)$/.test(url.pathname)) return result;
      const row: (typeof rows)[number] = { path: url.pathname, start: performance.now() };
      rows.push(row);
      void result.then(async response => {
        row.end = performance.now();
        row.status = response.status;
        row.serverTiming = response.headers.get("server-timing");
        row.outcome = "response";
        if (!row.path.endsWith("/sandbox-settings")) return;
        const body: unknown = await response.clone().json();
        if (!body || typeof body !== "object") return;
        if ("verification" in body && typeof body.verification === "string") row.verification = body.verification;
        if ("featureEnabled" in body && typeof body.featureEnabled === "boolean") row.featureEnabled = body.featureEnabled;
        if ("pending" in body && typeof body.pending === "boolean") row.pending = body.pending;
      }, () => {
        row.end = performance.now();
        row.outcome = init?.signal?.aborted ? "aborted" : "rejected";
      }).catch(() => undefined);
      return result;
    };
    Reflect.set(window, "__permissionsFetchTrace", () => { globalThis.fetch = upstream; return rows; });
  });
  return () => evaluateOnSurface(surface, () => {
    const finish: unknown = Reflect.get(window, "__permissionsFetchTrace");
    Reflect.deleteProperty(window, "__permissionsFetchTrace");
    if (typeof finish !== "function") throw new Error("Renderer fetch trace missing");
    const rows: unknown = finish();
    return rows;
  });
}
