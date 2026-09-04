import { expect } from "vitest";
import { control, createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import { connect, debuggerUrlFor, evaluate, navigate, targetById } from "@openwork/cdp";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";
import { screenshot } from "@openwork/test-evidence";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "the organization browser URL allowlist blocks every route into a disallowed website and clears cleanly"
  : "browser URL allowlist policy skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

const BLOCKED_TITLE = "Blocked by your organization";
// The desktop's own local OpenWork server answers GET /health without a token
// on the app host's loopback, so the same page is reachable as 127.0.0.1 and
// as localhost. Only the host name differs, which is exactly what the
// allowlist keys on — and nothing depends on the public internet.
const HEALTH_BODY_MARKER = '"ok":true';

type Surface = Parameters<typeof evalIn>[0];
type OpenUrlResult = { browser_url: string; target_id: string; tab_id: string; url: string };
type ControlOutcome = { ok: true; result: unknown } | { ok: false; error: string };

function isOpenUrlResult(value: unknown): value is OpenUrlResult {
  return typeof value === "object" && value !== null
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

async function applyDesktopConfig(app: Surface, config: Record<string, unknown>): Promise<void> {
  const applied = await evalIn(app, `(() => {
    if (!window.__openworkApplyDesktopConfig) return false;
    window.__openworkApplyDesktopConfig(${JSON.stringify(config)});
    window.__openworkSetDesktopConfigRefreshResult?.(${JSON.stringify(config)});
    return true;
  })()`);
  expect(applied).toBe(true);
}

async function waitForShellPolicy(app: Surface, allowedHosts: string[] | null): Promise<void> {
  await waitFor(
    app,
    `window.__OPENWORK_ELECTRON__.browser.getUrlPolicy().then((state) =>
      JSON.stringify(state.allowedHosts) === ${jsString(JSON.stringify(allowedHosts))})`,
    { awaitPromise: true, timeoutMs: 15_000, label: `shell browser policy ${JSON.stringify(allowedHosts)}` },
  );
}

/**
 * Drive the agent-facing `browser.open_url` control action — the path the
 * OpenWork tool uses. `control()` throws when the action reports `ok: false`,
 * which is exactly how a blocked website surfaces to the agent.
 */
async function openUrl(app: Surface, url: string): Promise<ControlOutcome> {
  try {
    return { ok: true, result: await control(app, "browser.open_url", { url, provider: "builtin" }) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function openedTab(outcome: ControlOutcome): OpenUrlResult {
  if (!outcome.ok || !isOpenUrlResult(outcome.result)) {
    throw new Error(`browser.open_url did not return a tab: ${JSON.stringify(outcome)}`);
  }
  return outcome.result;
}

async function waitForTab(app: Surface, tabId: string, predicate: string, label: string): Promise<void> {
  await waitFor(
    app,
    `window.__OPENWORK_ELECTRON__.browser.getState().then((state) =>
      (state?.tabs ?? []).some((tab) => tab.id === ${jsString(tabId)} && (${predicate})))`,
    { awaitPromise: true, timeoutMs: 30_000, label: `tab ${tabId} ${label}` },
  );
}

function waitForLoadedPage(app: Surface, tabId: string, url: string): Promise<void> {
  return waitForTab(app, tabId, `tab.url === ${jsString(url)} && tab.status === "ready"`, `loaded ${url}`);
}

function waitForBlockedPage(app: Surface, tabId: string): Promise<void> {
  return waitForTab(app, tabId, `tab.label === ${jsString(BLOCKED_TITLE)} && tab.status === "ready"`, "on the blocked page");
}

async function activeTabId(app: Surface): Promise<string> {
  const id = await evalIn(
    app,
    `window.__OPENWORK_ELECTRON__.browser.getState().then((state) => state?.activeTabId ?? null)`,
    { awaitPromise: true },
  );
  expect(typeof id).toBe("string");
  return String(id);
}

async function tabsOnHost(app: Surface, hostAndPort: string): Promise<unknown> {
  return evalIn(
    app,
    `window.__OPENWORK_ELECTRON__.browser.getState().then((state) =>
      (state?.tabs ?? []).filter((tab) => String(tab.url ?? "").includes(${jsString(`//${hostAndPort}/`)})).length)`,
    { awaitPromise: true },
  );
}

async function waitForPageTitle(client: Awaited<ReturnType<typeof connect>>, expected: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(client, "document.title");
      if (last === expected) return;
    } catch {
      // The document is briefly unavailable while the blocked page replaces the cancelled load.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Tab title stayed ${JSON.stringify(last)}; expected ${JSON.stringify(expected)}.`);
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

  await using app = await desktop({ name: "browser-url-allowlist-policy" });
  await createAndSelectWorkspace(app, { path: `/tmp/openwork-browser-url-allowlist-policy-${Date.now()}` });

  const port = await localServerPort(app);
  const allowedHost = `127.0.0.1:${port}`;
  const blockedHost = `localhost:${port}`;
  const allowedPage = (path: string) => `http://${allowedHost}/health?${path}`;
  const blockedPage = (path: string) => `http://${blockedHost}/health?${path}`;

  // Baseline: without a policy the built-in browser opens the page under either host name.
  await waitForShellPolicy(app, null);
  const baseline = openedTab(await openUrl(app, blockedPage("baseline")));
  await waitForLoadedPage(app, baseline.tab_id, blockedPage("baseline"));
  evidence.recordAssertionEvidence(
    "Without a policy the built-in browser opens any host",
    `browser.open_url loaded ${blockedPage("baseline")} in tab ${baseline.tab_id} while the shell reported no allowlist.`,
    true,
  );

  // Claim 1: the effective desktop policy reaches the Electron shell…
  await applyDesktopConfig(app, { allowedBrowserHosts: ["127.0.0.1"] });
  await waitForShellPolicy(app, ["127.0.0.1"]);
  evidence.recordAssertionEvidence(
    "The effective desktop policy reaches the Electron shell",
    'After the desktop config gained allowedBrowserHosts ["127.0.0.1"], browser.getUrlPolicy() reported that exact allowlist.',
    true,
  );
  // …and a tab already sitting on a now-disallowed page is replaced by the blocked page.
  await waitForBlockedPage(app, baseline.tab_id);
  evidence.recordAssertionEvidence(
    "A tab already on a now-disallowed host moves to the blocked page",
    `Tab ${baseline.tab_id}, previously on ${blockedHost}, now shows "${BLOCKED_TITLE}".`,
    true,
  );

  // Claim 2: the agent's open_url request for a disallowed host is refused with the reason
  // and leaves no tab behind on that host.
  const refused = await openUrl(app, blockedPage("agent-open"));
  expect(refused).toMatchObject({ ok: false, error: expect.stringContaining(BLOCKED_TITLE) });
  expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("localhost") });
  expect(await tabsOnHost(app, blockedHost)).toBe(0);
  evidence.recordAssertionEvidence(
    "The agent's browser.open_url is refused for a disallowed host",
    `browser.open_url(${blockedPage("agent-open")}) failed with ${JSON.stringify(refused.ok ? "" : refused.error)} and no tab exists on ${blockedHost}.`,
    true,
  );

  // Claim 3 (negative half): an allowed host still opens and loads.
  const allowed = openedTab(await openUrl(app, allowedPage("agent-allowed")));
  await waitForLoadedPage(app, allowed.tab_id, allowedPage("agent-allowed"));
  evidence.recordAssertionEvidence(
    "An allowed host still opens through browser.open_url",
    `browser.open_url returned CDP target ${allowed.target_id} and tab ${allowed.tab_id} finished loading ${allowedPage("agent-allowed")}.`,
    true,
  );

  // Claim 4: CDP Page.navigate on that tab (the browser_navigate tool path) cannot escape the
  // allowlist — the load is cancelled and the tab shows the blocked page naming the host —
  // while the same CDP session can still reach an allowed page afterwards. The tab is a
  // target of the same Electron CDP endpoint the harness drives the app through, so reach it
  // via the app's CDP base: `browser_url` is the app host's loopback, which a remote driver
  // (Daytona) cannot dial directly.
  const appCdpPort = new URL(app.handle.cdpUrl).port;
  if (appCdpPort) expect(new URL(allowed.browser_url).port).toBe(appCdpPort);
  const target = await targetById(app.handle.cdpUrl, allowed.target_id);
  const client = await connect(debuggerUrlFor(app.handle.cdpUrl, target));
  try {
    await waitForPageBody(client, HEALTH_BODY_MARKER);
    await navigate(client, blockedPage("cdp-navigate")).catch(() => undefined);
    await waitForPageTitle(client, BLOCKED_TITLE);
    const blockedHostName = await evaluate(
      client,
      `document.querySelector('meta[name="openwork-browser-blocked"]')?.getAttribute("content") ?? null`,
    );
    expect(blockedHostName).toBe("localhost");
    expect(await tabsOnHost(app, blockedHost)).toBe(0);
    evidence.recordAssertionEvidence(
      "CDP Page.navigate cannot escape the allowlist",
      `Page.navigate to ${blockedPage("cdp-navigate")} on target ${allowed.target_id} ended on "${BLOCKED_TITLE}" naming host ${JSON.stringify(blockedHostName)}; no tab exists on ${blockedHost}.`,
      true,
    );

    await navigate(client, allowedPage("cdp-allowed"));
    await waitForPageBody(client, HEALTH_BODY_MARKER);
    await waitForLoadedPage(app, allowed.tab_id, allowedPage("cdp-allowed"));
    evidence.recordAssertionEvidence(
      "The same CDP session still reaches an allowed page afterwards",
      `Page.navigate to ${allowedPage("cdp-allowed")} loaded the health page body on target ${allowed.target_id}.`,
      true,
    );
  } finally {
    client.close();
  }

  // Claim 5: an address-bar navigation to a disallowed host lands on the blocked page.
  await evalIn(app, `window.__OPENWORK_ELECTRON__.browser.navigate(${jsString(blockedPage("typed"))})`, {
    awaitPromise: true,
  });
  await waitForBlockedPage(app, await activeTabId(app));
  expect(await tabsOnHost(app, blockedHost)).toBe(0);
  evidence.recordAssertionEvidence(
    "An address-bar navigation to a disallowed host lands on the blocked page",
    `browser.navigate(${blockedPage("typed")}) left the active tab on "${BLOCKED_TITLE}" with no tab on ${blockedHost}.`,
    true,
  );
  await screenshot(app);

  // Claim 6: clearing the policy restores unrestricted browsing to the previously blocked host.
  await applyDesktopConfig(app, {});
  await waitForShellPolicy(app, null);
  const restored = openedTab(await openUrl(app, blockedPage("restored")));
  await waitForLoadedPage(app, restored.tab_id, blockedPage("restored"));
  evidence.recordAssertionEvidence(
    "Clearing the policy restores the previously blocked host",
    `After the desktop config dropped allowedBrowserHosts, the shell reported no allowlist and browser.open_url loaded ${blockedPage("restored")} in tab ${restored.tab_id}.`,
    true,
  );
});
