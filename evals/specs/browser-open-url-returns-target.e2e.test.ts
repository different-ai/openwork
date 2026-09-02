import { expect } from "vitest";
import { control, createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import { connect, debuggerUrlFor, evaluate, targetById } from "@openwork/cdp";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "browser.open_url opens the page and hands the agent a live CDP target for it"
  : "browser.open_url target handoff skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

// The desktop's own local OpenWork server answers GET /health without a token
// on the app host's loopback, so the proof needs no public internet.
const HEALTH_BODY_MARKER = '"ok":true';

type Surface = Parameters<typeof evalIn>[0];
type OpenUrlResult = { provider: string; browser_url: string; target_id: string; tab_id: string; url: string };

function isOpenUrlResult(value: unknown): value is OpenUrlResult {
  return typeof value === "object" && value !== null
    && typeof Reflect.get(value, "provider") === "string"
    && typeof Reflect.get(value, "browser_url") === "string"
    && typeof Reflect.get(value, "target_id") === "string"
    && typeof Reflect.get(value, "tab_id") === "string"
    && typeof Reflect.get(value, "url") === "string";
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

async function localServerPort(app: Surface): Promise<number> {
  const port = await evalIn(app, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return null;
    return Number(new URL(String(info.baseUrl)).port) || null;
  })()`, { awaitPromise: true });
  if (typeof port !== "number") throw new Error(`Local OpenWork server is not running: ${JSON.stringify(port)}`);
  return port;
}

/** The agent-facing control action — the exact path the OpenWork browser tool uses. */
async function openUrl(app: Surface, url: string): Promise<OpenUrlResult> {
  const result = await control(app, "browser.open_url", { url, provider: "builtin" });
  if (!isOpenUrlResult(result)) throw new Error(`browser.open_url did not return a tab handle: ${JSON.stringify(result)}`);
  return result;
}

async function waitForLoadedTab(app: Surface, tabId: string, url: string): Promise<void> {
  await waitFor(
    app,
    `window.__OPENWORK_ELECTRON__.browser.getState().then((state) =>
      (state?.tabs ?? []).some((tab) => tab.id === ${jsString(tabId)} && tab.url === ${jsString(url)} && tab.status === "ready"))`,
    { awaitPromise: true, timeoutMs: 30_000, label: `tab ${tabId} loaded ${url}` },
  );
}

async function waitForPageBody(client: Awaited<ReturnType<typeof connect>>, marker: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(client, "document.body ? document.body.innerText : null");
      if (typeof last === "string" && last.includes(marker)) return;
    } catch {
      // Navigation in flight.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Page body never contained ${JSON.stringify(marker)}; last ${JSON.stringify(last)}.`);
}

test.skipIf(!e2eTestsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({ name: "browser-open-url-returns-target" });
  await createAndSelectWorkspace(app, { path: `/tmp/openwork-browser-open-url-returns-target-${Date.now()}` });
  const port = await localServerPort(app);
  const pageUrl = (path: string) => `http://127.0.0.1:${port}/health?${path}`;

  // Claim 1: the action resolves with a built-in browser handle instead of rejecting.
  const first = await openUrl(app, pageUrl("first"));
  expect(first.provider).toBe("builtin");
  expect(first.url).toBe(pageUrl("first"));
  evidence.recordAssertionEvidence(
    "browser.open_url resolves with a built-in browser handle",
    `The control action returned provider ${first.provider}, tab ${first.tab_id}, and CDP target ${first.target_id} for ${first.url}.`,
    true,
  );

  // Claim 2: the tab it created finishes loading the requested page.
  await waitForLoadedTab(app, first.tab_id, pageUrl("first"));
  evidence.recordAssertionEvidence(
    "The new tab loads the requested page",
    `Tab ${first.tab_id} reports url ${pageUrl("first")} with status ready.`,
    true,
  );

  // Claim 3: the returned target id is a live page target of the same Electron CDP
  // endpoint the harness drives the app through, and it shows the loaded page.
  // (`browser_url` is the app host's loopback, which a remote driver cannot dial.)
  const appCdpPort = new URL(app.handle.cdpUrl).port;
  if (appCdpPort) expect(new URL(first.browser_url).port).toBe(appCdpPort);
  const target = await targetById(app.handle.cdpUrl, first.target_id);
  const client = await connect(debuggerUrlFor(app.handle.cdpUrl, target));
  try {
    await waitForPageBody(client, HEALTH_BODY_MARKER);
    const location = await evaluate(client, "window.location.href");
    expect(location).toBe(pageUrl("first"));
  } finally {
    client.close();
  }
  evidence.recordAssertionEvidence(
    "The returned CDP target is the loaded page",
    `Target ${first.target_id} answered Runtime.evaluate with location ${pageUrl("first")} and a body containing ${HEALTH_BODY_MARKER}.`,
    true,
  );

  // Claim 4: a second request opens a second tab; agents open many pages per task.
  const second = await openUrl(app, pageUrl("second"));
  expect(second.tab_id).not.toBe(first.tab_id);
  expect(second.target_id).not.toBe(first.target_id);
  await waitForLoadedTab(app, second.tab_id, pageUrl("second"));
  evidence.recordAssertionEvidence(
    "A second browser.open_url opens a second, independent tab",
    `Tab ${second.tab_id} (target ${second.target_id}) loaded ${pageUrl("second")} while tab ${first.tab_id} stayed separate.`,
    true,
  );
});
