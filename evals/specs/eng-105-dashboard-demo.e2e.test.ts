import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { denFetch, evalIn, fill, signInInBrowser, waitFor, type DenSession } from "@openwork/behaviors";
import { browserScript, captureBrowserFilm, clickAt, connect, debuggerUrlFor, evaluate, listTargets, navigate, reload, type Surface } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import { screenshot } from "@openwork/test-evidence";
import { eventually, test } from "@openwork/testkit";
import { assertReleaseSource, bootAcmeDemoEng105 } from "../../worlds/acme-demo-eng105.ts";

// Den Web authors references; the two real desktops execute the referenced Apps.
// No Workflow snapshot, shared calendar credential, API-authored dashboard, or
// synthetic app HTML may stand in for this journey. Prerequisite failures fail
// this test (zero skip branches), and screenshots are supplementary to assertions.
const runName = new Date().toISOString().replaceAll(":", "-");
const reportDirectory = fileURLToPath(new URL(`../../reports/demo/eng105-proof/${runName}/`, import.meta.url));
const captures: { name: string; at: string; actor: string; status: string }[] = [];
const provenance = {
  lane: "local-release-source", buildKind: "release-source", desktopVersion: "0.18.46", desktopTag: "v0.18.46",
  releaseSha: "a0d6bd1de8debf4f09d22b8538e124b2ff45b339",
  denBuildIdentity: "v0.18.46 release source a0d6bd1de8debf4f09d22b8538e124b2ff45b339",
  desktopSourceSha: "a0d6bd1de8debf4f09d22b8538e124b2ff45b339",
  denSourceSha: "a0d6bd1de8debf4f09d22b8538e124b2ff45b339",
  packagedBinaryVerification: false,
  laneReason: "Required demo-org seed/world has no Daytona placement implementation; Daytona service itself reachable; local source fallback explicitly authorized",
  overlaySha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8" }).trim(),
};
const boardName = "Acme Day";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error("Expected an API object");
  return value;
}
function text(value: unknown, key: string): string {
  const result = object(value)[key];
  if (typeof result !== "string" || !result) throw new Error(`Expected ${key}`);
  return result;
}
function array(value: unknown, key: string): Record<string, unknown>[] {
  const result = object(value)[key];
  if (!Array.isArray(result)) throw new Error(`Expected ${key} array`);
  return result.map(object);
}
async function api(session: DenSession, orgId: string, path: string) {
  const result = await denFetch(session, path, { headers: {
    authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId,
  } });
  // Never include raw response bodies/headers: they can contain credentials.
  expect(result.response.status, `GET ${path}`).toBe(200);
  return result.body;
}
async function clickTarget(surface: Surface, target: { role?: string; label?: string | RegExp; testId?: string; rowTitle?: string }) {
  const expression = target.label instanceof RegExp ? target.label.source : null;
  const flags = target.label instanceof RegExp ? target.label.flags : "";
  const exact = typeof target.label === "string" ? target.label : "";
  const point = await eventually(() => evalIn(surface, browserScript((role, testId, exact, expression, flags, rowTitle) => {
    const selector = testId ? `[data-testid="${testId}"]` : role === "button" ? 'button,[role="button"]' : `[role="${role}"]`;
    const found = [...document.querySelectorAll<HTMLElement>(selector)].find(element => {
      const label = (element.getAttribute("aria-label") || (element instanceof HTMLInputElement ? [...element.labels ?? []].map(label => label.textContent).join(" ") : "") || element.textContent || "").trim();
      const box = element.getBoundingClientRect();
      return (!rowTitle || element.parentElement?.querySelector("p")?.textContent?.trim() === rowTitle)
        && box.width > 0 && box.height > 0 && !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true"
        && (testId || (expression ? new RegExp(expression, flags).test(label) : label === exact));
    });
    if (!found) return null;
    found.scrollIntoView({ block: "center" });
    const box = found.getBoundingClientRect();
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const hit = document.elementFromPoint(point.x, point.y);
    return hit && (hit === found || found.contains(hit)) ? point : null;
  }, [target.role ?? "", target.testId ?? "", exact, expression, flags, target.rowTitle ?? ""])),
  { within: 60_000, until: point => point !== null, label: `clickable ${target.testId ?? String(target.label)}` });
  if (!point) throw new Error("Control not visible for trusted pointer input");
  await clickAt(surface, point);
}
async function allowClockSaveDialog(surface: Surface, serverName: string) {
  const url = surface.client.webSocketDebuggerUrl;
  if (!url) throw new Error("Missing owned desktop CDP socket");
  const socket = new WebSocket(url);
  const expected = `Allow this MCP App to call save_preferences on ${serverName}?`;
  const observed: { expected: boolean; accepted: boolean }[] = [];
  let approved = 0;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("Native-dialog observer setup timed out")); }, 10_000);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Page.enable" }));
    socket.onerror = () => { clearTimeout(timer); reject(new Error("Native-dialog observer disconnected")); };
    socket.onmessage = event => {
      const message = object(JSON.parse(String(event.data)));
      if (message.id === 1) { clearTimeout(timer); resolve(); }
      if (message.method === "Page.javascriptDialogOpening") {
        const params = object(message.params);
        const matches = params.type === "confirm" && params.message === expected;
        observed.push({ expected: matches, accepted: false });
        if (matches) socket.send(JSON.stringify({ id: 2, method: "Page.handleJavaScriptDialog", params: { accept: true } }));
      }
      if (message.id === 2 && !message.error) {
        approved += 1;
        const last = observed.at(-1);
        if (last) last.accepted = true;
      }
    };
  });
  return { observed, approved: () => approved, [Symbol.asyncDispose]: async () => socket.close() };
}
async function frame(surface: Surface, title: string): Promise<Surface & AsyncDisposable> {
  return eventually(async () => {
    // The released host nests srcdoc inside its sandbox proxy rather than
    // always creating a separate srcdoc target. Inspect the actual frame tree.
    const targets = (await listTargets(surface.handle.cdpUrl))
      .filter(target => target.type === "iframe" && (target.url === "about:srcdoc" || target.url.includes("/mcp-apps/sandbox.html")));
    for (const target of targets) {
      const raw = await connect(debuggerUrlFor(surface.handle.cdpUrl, target));
      let matched = false;
      try {
        const tree = object(await raw.send("Page.getFrameTree"));
        const frames: string[] = [];
        const visit = (value: unknown) => {
          const node = object(value);
          const current = object(node.frame);
          if (current.url === "about:srcdoc") frames.push(text(current, "id"));
          if (Array.isArray(node.childFrames)) node.childFrames.forEach(visit);
        };
        visit(tree.frameTree);
        for (const frameId of frames) {
          const context = object(await raw.send("Page.createIsolatedWorld", { frameId, worldName: "eng105-visible-app" }));
          const contextId = context.executionContextId;
          if (typeof contextId !== "number") throw new Error("Missing App execution context");
          const client = { ...raw, send: (method: string, params: Record<string, unknown> = {}, options?: { timeoutMs?: number }) => raw.send(method,
            method === "Runtime.evaluate" ? { ...params, contextId }
              : method === "Runtime.callFunctionOn" ? { ...params, executionContextId: contextId } : params, options) };
          matched = await evaluate(client, browserScript(title => document.title === title, [title]));
          if (matched) return { handle: surface.handle, client, [Symbol.asyncDispose]: async () => raw.close() };
        }
      } finally { if (!matched) raw.close(); }
    }
    throw new Error(`Real MCP App iframe not mounted: ${title}`);
  }, { within: 90_000, intervalMs: 1_000, label: `rendered ${title} iframe` });
}
async function checkpoint(surface: Surface, name: string) {
  const artifact = await screenshot(surface);
  console.log(`[ENG105] captured ${name}`);
  await writeFile(`${reportDirectory}${name}.png`, artifact.png);
  captures.push({ name: `${name}.png`, at: artifact.at,
    actor: name.includes("jordan") ? "Jordan" : "Alex", status: "supplementary observation; see test-run verdict" });
  await writeFile(`${reportDirectory}captures.json`, JSON.stringify(captures, null, 2));
  const exportRoot = process.env.ENG105_EXPORT_DIR;
  if (exportRoot) {
    const directory = `${exportRoot}/${runName}`;
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/${name}.png`, artifact.png);
    await writeFile(`${directory}/captures.json`, JSON.stringify(captures, null, 2));
    await writeFile(`${directory}/provenance.json`, JSON.stringify(provenance, null, 2));
  }
}
async function see(surface: Surface, value: string) {
  await waitFor(surface, browserScript(value => document.body.innerText.toLowerCase().includes(value.toLowerCase()), [value]),
    { timeoutMs: 90_000, label: `visible ${value}` });
}
async function revealApp(surface: Surface, title: string) {
  await waitFor(surface, browserScript(title => {
    const button = [...document.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === `Refresh ${title}`);
    const tile = button?.closest("[data-dashboard-entry]");
    if (!tile) return false;
    tile.scrollIntoView({ block: "start" });
    return true;
  }, [title]), { timeoutMs: 60_000, label: `scroll ${title} into the real desktop viewport` });
}
async function refresh(surface: Surface, title: string) {
  const calls = () => evalIn(surface, () => performance.getEntriesByType("resource")
    .filter(entry => new URL(entry.name).pathname.endsWith("/mcp-apps/call")).length);
  const before = await calls();
  // v0.18.46 uses a visible header Refresh button (the options menu is unreleased).
  await clickTarget(surface, { role: "button", label: `Refresh ${title}` });
  await eventually(calls, { within: 90_000, until: count => count > before, label: `${title} Refresh made a completed host tool request` });
}

interface CalendarView { name: string; identity: string; generation: number; meetings: string[]; instanceId: string; generatedAt: string }
async function calendarView(surface: Surface): Promise<CalendarView> {
  // Read this exact child context without the generic Surface auto-healing to
  // the desktop root. The caller reacquires a fresh child on every retry.
  const result = await evaluate(surface.client, () => ({
    name: document.querySelector('[data-testid="calendar-name"]')?.textContent?.trim() ?? "",
    identity: document.querySelector('[data-testid="calendar-identity"]')?.textContent?.trim() ?? "",
    generation: Number(document.querySelector('[data-testid="calendar-generation"]')?.textContent?.match(/\d+/)?.[0]),
    meetings: [...document.querySelectorAll('[data-testid="calendar-meeting-title"]')].map(node => node.textContent?.trim() ?? ""),
    instanceId: document.querySelector('[data-testid="calendar-instance-id"]')?.textContent?.trim() ?? "",
    generatedAt: document.querySelector('[data-testid="calendar-generated-at"]')?.textContent?.trim() ?? "",
  }));
  if (!result.name || !result.identity || !result.instanceId || !Number.isFinite(Date.parse(result.generatedAt)) || !Number.isFinite(result.generation) || !result.meetings.length) {
    throw new Error(`Calendar UI fields incomplete: ${JSON.stringify(result)}`);
  }
  return result;
}

// Explicitly opt in when running. Missing opt-in is an error, not a green skip.
test("ENG-105 Den Web shares real MCP Apps; separate member calendars refresh independently and clock edits survive relaunch", { timeout: 1_800_000 }, async ({ place, evidence }) => {
  expect(process.env.OPENWORK_EVAL_E2E_TESTS, "Set OPENWORK_EVAL_E2E_TESTS=1").toBe("1");
  await mkdir(reportDirectory, { recursive: true });
  await using stack = new AsyncDisposableStack();
  const world = await bootAcmeDemoEng105(stack, place);
  const { den, alex, jordan, jordanSession, orgId } = world;
  expect(alex.handle.cdpUrl).not.toBe(jordan.handle.cdpUrl);
  expect(den.admin.email).not.toBe(jordanSession.email);
  const registrations = world.registrations.filter(receipt => receipt.phase === "verified-state");
  await writeFile(`${reportDirectory}setup-receipts.json`, JSON.stringify({
    setupExitCodes: world.setupExitCodes, registrations: world.registrations, reapplyRegistrations: world.reapplyRegistrations,
  }, null, 2));
  expect(world.setupExitCodes, "Portable connection setup and idempotent reapply").toEqual([0, 0]);
  const firstApply = world.registrations.filter(receipt => receipt.phase === "apply");
  const secondApply = world.reapplyRegistrations.filter(receipt => receipt.phase === "apply");
  expect(firstApply).toHaveLength(3);
  expect(secondApply).toHaveLength(3);
  for (const first of firstApply) {
    expect(first.status).toBe(201);
    const second = secondApply.find(receipt => receipt.key === first.key);
    expect(second?.status).toBe(200);
    expect(second?.connectionId).toBe(first.connectionId);
    expect(object(second).changedFields).toEqual([]);
  }
  evidence.recordAssertionEvidence("Three real hosted org connections registered", JSON.stringify(registrations),
    registrations.length === 3 && registrations.every(receipt => receipt.ok && receipt.connectionId));
  expect(registrations).toHaveLength(3);
  expect(registrations.every(receipt => receipt.ok && receipt.connectionId)).toBe(true);
  await writeFile(`${reportDirectory}world-sanitized.json`, JSON.stringify({
    ...provenance, mcpUrls: world.mcpUrls, denWeb: den.ref.webUrl, denApi: den.ref.apiUrl,
    alexCdp: alex.handle.cdpUrl, jordanCdp: jordan.handle.cdpUrl,
    alexEmail: den.admin.email, jordanEmail: jordanSession.email, orgId, registrations,
  }, null, 2));

  const registration = (key: string) => {
    const value = registrations.find(receipt => receipt.key === key);
    if (!value?.connectionId) throw new Error(`Missing successful ${key} registration`);
    return { id: value.connectionId, url: value.url };
  };
  const home = registration("acme-home-demo");
  const clocks = registration("world-clocks-demo");
  const calendar = registration("personal-calendar-demo");
  const calendarConfiguration = object(await api(den.admin, orgId, `/v1/mcp-connections/${calendar.id}`));
  expect(calendarConfiguration.requestedScopes).toEqual(["calendar:read"]);
  await writeFile(`${reportDirectory}calendar-auth-contract.json`, JSON.stringify({
    authType: calendarConfiguration.authType, credentialMode: calendarConfiguration.credentialMode,
    requestedScopes: calendarConfiguration.requestedScopes,
  }, null, 2));
  const alexBrowser = stack.use(await chrome({ name: "eng105-alex-den-web", host: place.host(), startUrl: den.ref.webUrl, headless: true }));
  const jordanBrowser = stack.use(await chrome({ name: "eng105-jordan-den-web", host: place.host(), startUrl: den.ref.webUrl, headless: true }));
  expect(alexBrowser.handle.cdpUrl).not.toBe(jordanBrowser.handle.cdpUrl);

  const claimResults: { claim: string; status: "Passed" | "Failed" | "Blocked"; detail: string }[] = [];
  const writeClaims = async () => {
    await writeFile(`${reportDirectory}claims.json`, JSON.stringify({ ...provenance, claims: claimResults }, null, 2));
    if (process.env.ENG105_EXPORT_DIR) {
      const directory = `${process.env.ENG105_EXPORT_DIR}/${runName}`;
      await mkdir(directory, { recursive: true });
      await writeFile(`${directory}/claims.json`, JSON.stringify({ ...provenance, claims: claimResults }, null, 2));
    }
  };
  try {
  const signIn = async (browser: Surface, session: DenSession) => {
    await navigate(browser.client, den.ref.webUrl);
    await signInInBrowser(browser, den.ref.webUrl, session);
    await waitFor(browser, () => location.pathname.startsWith("/dashboard"), { timeoutMs: 60_000, label: "signed in to owned Den" });
  };
  const yourCalendar = async (browser: Surface, session: DenSession, prefix: string) => {
    const before = array(await api(session, orgId, "/v1/mcp-connections?scope=usable"), "connections")
      .find(connection => connection.id === calendar.id);
    expect(before).toBeDefined();
    expect(before?.credentialMode).toBe("per_member");
    expect(before?.authType).toBe("oauth");
    expect(before?.connectedForMe, "No member credentials are pre-seeded").not.toBe(true);
    await navigate(browser.client, new URL(`/dashboard/your-connections?connectionId=${calendar.id}`, den.ref.webUrl).href);
    await see(browser, "Connect your account");
    await checkpoint(browser, `${prefix}-your-connections-before`);
    await clickTarget(browser, { testId: `connect-my-mcp-account-${calendar.id}` });
    // The real OAuth popup follows the AS's auto-approve redirect. We neither
    // manufacture a code/callback nor copy Alex's authorization to Jordan.
    const outcome = await eventually(async () => {
      const connection = array(await api(session, orgId, "/v1/mcp-connections?scope=usable"), "connections")
        .find(connection => connection.id === calendar.id);
      const failure = await evalIn(browser, () => document.body.innerText.match(/Could not connect[^\n]+/)?.[0] ?? null);
      return { connected: connection?.connectedForMe === true && connection.needsReconnect !== true, failure };
    }, { within: 120_000, intervalMs: 2_000, label: `${prefix} visible OAuth outcome`,
      until: result => result.connected || result.failure !== null });
    if (outcome.failure) throw new Error(`Your Connections → Connect: ${outcome.failure}`);
    expect(outcome.connected).toBe(true);
    await see(browser, "Connected as you");
    await checkpoint(browser, `${prefix}-your-connections-connected`);
  };
  await signIn(alexBrowser, den.admin);
  await navigate(alexBrowser.client, new URL("/dashboard/mcp-connections", den.ref.webUrl).href);
  await clickTarget(alexBrowser, { testId: "connectors-open-configured" });
  await see(alexBrowser, "Acme Home");
  await see(alexBrowser, "World Clocks");
  await see(alexBrowser, "Personal Calendar");
  await checkpoint(alexBrowser, "00-alex-organization-connections");

  const catalog = async (id: string) => array(await api(den.admin, orgId, `/v1/mcp-connections/${id}/mcp-apps`), "apps");
  const homeApps = await catalog(home.id);
  const clockApps = await catalog(clocks.id);
  const homeApp = homeApps.find(app => app.toolName === "acme_home");
  const clockApp = clockApps.find(app => app.toolName === "show_world_clocks");
  expect(homeApp).toBeDefined();
  expect(clockApp).toBeDefined();
  if (!homeApp || !clockApp) throw new Error("Missing real Home/Clocks MCP App catalog entries");
  expect(homeApp.resourceUri).toBe("ui://acme-home/home.html");
  expect(clockApp.resourceUri).toBe("ui://world-clocks/mcp-app.html");

  await navigate(alexBrowser.client, new URL("/dashboard/dashboards", den.ref.webUrl).href);
  await clickTarget(alexBrowser, { role: "button", label: "New dashboard" });
  await fill(alexBrowser, 'input[placeholder="Support overview"]', boardName);
  await clickTarget(alexBrowser, { role: "button", label: "Create dashboard" });
  await see(alexBrowser, "Who sees this dashboard");
  const dashboardId = await evalIn(alexBrowser, () => location.pathname.split("/").at(-1));
  if (typeof dashboardId !== "string" || !dashboardId.startsWith("dsb_")) throw new Error("Dashboard detail route missing");
  const readBoard = () => api(den.admin, orgId, `/v1/dashboards/${dashboardId}`);
  const addApp = async (entry: { name: string; app: Record<string, unknown> }, index: number) => {
    await clickTarget(alexBrowser, { role: "button", label: "Add app" });
    await clickTarget(alexBrowser, { role: "button", label: "MCP" });
    await clickTarget(alexBrowser, { role: "option", label: entry.name });
    await see(alexBrowser, text(entry.app, "title"));
    // Default {} is intentional: no explicit city list or identity overrides.
    expect(entry.app.requiresInput, "Demo launch requires no identity/city input").not.toBe(true);
    await clickTarget(alexBrowser, { role: "button", label: "Add", rowTitle: text(entry.app, "title") });
    await eventually(async () => array(object(await readBoard()).item, "elements").length,
      { within: 30_000, until: count => count === index + 1, label: "UI Add persisted" });
    expect(array(object(await readBoard()).item, "elements")[index]?.toolName).toBe(entry.app.toolName);
    await clickTarget(alexBrowser, { role: "button", label: "Done" });
    await clickTarget(alexBrowser, { role: "switch", label: `Run ${text(entry.app, "title")} automatically, even if it modifies data` });
    await eventually(async () => array(object(await readBoard()).item, "elements")[index]?.organizationAutoLaunch,
      { within: 30_000, until: value => value === true, label: "UI organization auto-run persisted" });
    await checkpoint(alexBrowser, `0${index + 2}-den-add-${entry.name.toLowerCase().replaceAll(" ", "-")}`);
  };
  await addApp({ name: "Acme Home", app: homeApp }, 0);
  await addApp({ name: "World Clocks", app: clockApp }, 1);
  let elements = array(object(await readBoard()).item, "elements");
  expect(elements).toHaveLength(2);
  for (const element of elements) {
    expect(element.launchArguments, "Released UI omits empty defaults; host launches with {}").toBeUndefined();
    expect(element.organizationAutoLaunch).toBe(true);
    expect(element.connectionId).toBeDefined();
    expect(text(element, "resourceUri")).toMatch(/^ui:\/\//);
  }

  const org = object(await api(den.admin, orgId, "/v1/org"));
  const members = array(org, "members");
  const membership = (email: string) => {
    const found = members.find(member => object(member.user).email === email);
    if (!found) throw new Error("Missing named organization membership");
    return text(found, "id");
  };
  for (const session of [den.admin, jordanSession]) {
    await clickTarget(alexBrowser, { role: "button", label: "Add person" });
    await fill(alexBrowser, 'input[placeholder="Search people..."]', session.email);
    await clickTarget(alexBrowser, { role: "button", label: new RegExp(session.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    await clickTarget(alexBrowser, { role: "button", label: "Grant" });
    await eventually(async () => array(await api(den.admin, orgId, `/v1/dashboards/${dashboardId}/access`), "items")
      .some(grant => grant.orgMembershipId === membership(session.email) && grant.removedAt === null),
    { within: 30_000, until: Boolean, label: "named viewer grant persisted" });
  }
  const grants = array(await api(den.admin, orgId, `/v1/dashboards/${dashboardId}/access`), "items").filter(grant => grant.removedAt === null);
  expect(grants.map(grant => grant.orgMembershipId).sort()).toEqual([membership(den.admin.email), membership(jordanSession.email)].sort());
  expect(grants.every(grant => grant.role === "viewer" && grant.teamId == null)).toBe(true);
  await checkpoint(alexBrowser, "05-den-named-sharing");
  const jordanGranted = array(await api(jordanSession, orgId, "/v1/me/dashboards"), "items").find(item => item.id === dashboardId);
  expect(jordanGranted).toBeDefined();
  expect(jordanGranted?.elements).toEqual(elements);
  evidence.recordAssertionEvidence("Real Den Web Add, auto-run and named-person grants persist references, not calendar data", JSON.stringify({ dashboardId, elements, grants }), true);

  await signIn(jordanBrowser, jordanSession);
  for (const [surface, label] of [[alex, "alex"], [jordan, "jordan"]] satisfies [Surface, string][]) {
    if (process.env.ENG105_CAPTURE_FILM === "1") {
      const directory = process.env.ENG105_EXPORT_DIR ? `${process.env.ENG105_EXPORT_DIR}/${runName}` : reportDirectory;
      stack.use(await captureBrowserFilm(surface, `${directory}/film-${label}`));
    }
    await evalIn(surface, () => performance.setResourceTimingBufferSize(5000));
    await clickTarget(surface, { role: "button", label: "Dashboard" });
    await waitFor(surface, browserScript(id => Boolean(document.querySelector(`[data-granted-dashboard="${id}"]`)), [dashboardId]),
      { timeoutMs: 90_000, label: `${label} sees granted dashboard` });
    await see(surface, boardName);
    await using homeFrame = await frame(surface, "Acme Home");
    await see(homeFrame, "Today at a Glance");
    await see(homeFrame, "Needs Your Attention");
    await see(homeFrame, "My Goals");
    expect(await evalIn(homeFrame, () => ({
      brand: document.querySelector(".brand")?.textContent?.trim(),
      greeting: document.querySelector("h1")?.textContent?.trim(),
      widgets: document.querySelectorAll(".widget").length,
    }))).toEqual({ brand: "Acme Home", greeting: expect.stringMatching(/^Good (morning|afternoon|evening)!$/), widgets: 3 });
    await checkpoint(surface, `07-${label}-shared-dashboard`);
  }

  claimResults.push({ claim: "Den Add, auto-run, named sharing, both Home/Clocks desktops", status: "Passed", detail: "Real UI and persisted reference assertions completed" });
  const claim = async <T>(name: string, action: () => Promise<T>): Promise<T | undefined> => {
    try {
      const result = await action();
      claimResults.push({ claim: name, status: "Passed", detail: "All observable assertions completed" });
      await writeClaims();
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown claim failure";
      claimResults.push({ claim: name, status: detail.startsWith("Blocked:") ? "Blocked" : "Failed", detail });
      evidence.recordAssertionEvidence(name, detail, false);
      for (const [surface, actor] of [[alex, "alex"], [jordan, "jordan"], [alexBrowser, "alex-den"], [jordanBrowser, "jordan-den"]] satisfies [Surface, string][]) {
        const safe = await evalIn(surface, () => !document.querySelector('input[type="password"]') && !/[?&](code|token|state)=/.test(location.search)).catch(() => false);
        if (safe) await checkpoint(surface, `claim-${claimResults.length}-failed-${actor}`).catch(() => undefined);
      }
      await writeClaims();
      return undefined;
    }
  };
  await writeClaims();
  // Independent member consent and Clock claims always run; a red claim cannot
  // conceal another member's result, and final aggregation forbids partial green.
  const alexConnected = await claim("Alex personal OAuth through Your Connections", async () => {
    await yourCalendar(alexBrowser, den.admin, "08-alex"); return true;
  });
  const calendarApp = await claim("Calendar added through Den UI with default arguments", async () => {
    if (!alexConnected) throw new Error("Blocked: Alex OAuth did not complete");
    const apps = await catalog(calendar.id);
    const app = apps.find(app => app.toolName === "show_calendar");
    if (!app) throw new Error("Missing show_calendar App");
    expect(app.resourceUri).toBe("ui://personal-calendar/mcp-app.html");
    await navigate(alexBrowser.client, new URL(`/dashboard/dashboards/${dashboardId}`, den.ref.webUrl).href);
    await see(alexBrowser, "Who sees this dashboard");
    await addApp({ name: "Personal Calendar", app }, 2);
    elements = array(object(await readBoard()).item, "elements");
    expect(elements).toHaveLength(3);
    expect(elements.every(element => element.organizationAutoLaunch === true && element.launchArguments === undefined)).toBe(true);
    return app;
  });
  const jordanConnected = await claim("Jordan personal OAuth through separate Your Connections", async () => {
    await yourCalendar(jordanBrowser, jordanSession, "09-jordan"); return true;
  });
  const readCalendar = (surface: Surface) => eventually(async () => {
    await using view = await frame(surface, "Personal Calendar");
    return await calendarView(view); // Keep the child socket alive until this read settles.
  }, { within: 60_000, intervalMs: 1_000, label: "current Calendar child has rendered personal fields" });
  const renderCalendar = async (surface: Surface, connected: boolean | undefined, member: string) => {
    if (!calendarApp || !connected) throw new Error(`Blocked: ${member} Calendar prerequisites incomplete`);
    const shared = array(await api(jordanSession, orgId, "/v1/me/dashboards"), "items").find(item => item.id === dashboardId);
    expect(shared?.elements).toEqual(elements);
    await reload(surface);
    await see(surface, boardName);
    await evalIn(surface, () => performance.setResourceTimingBufferSize(5000));
    await revealApp(surface, text(calendarApp, "title"));
    const result = await readCalendar(surface);
    await revealApp(surface, text(calendarApp, "title"));
    await checkpoint(surface, `10-${member}-personal-calendar`);
    return result;
  };
  const a = await claim("Alex real Calendar renders personal identity and meetings", () => renderCalendar(alex, alexConnected, "alex"));
  const j = await claim("Jordan real shared Calendar renders personal identity and meetings", () => renderCalendar(jordan, jordanConnected, "jordan"));
  await claim("Calendar member identities and meeting sets are different", async () => {
    if (!a || !j) throw new Error("Blocked: both personal calendars must render before comparison");
    expect(a.name).not.toBe(j.name); expect(a.identity).not.toBe(j.identity); expect(a.meetings).not.toEqual(j.meetings);
    evidence.recordAssertionEvidence("Same shared Calendar uses separate member identities", JSON.stringify({ alex: a, jordan: j }), true);
    return true;
  });
  const refreshed: CalendarView[] = [];
  for (const [surface, before, member] of [[alex, a, "alex"], [jordan, j, "jordan"]] satisfies [Surface, CalendarView | undefined, string][]) {
    await claim(`${member} Calendar Refresh makes a new default tool invocation`, async () => {
      if (!before || !calendarApp) throw new Error(`Blocked: ${member} Calendar did not render`);
      await refresh(surface, text(calendarApp, "title"));
      const after = await eventually(() => readCalendar(surface), {
        within: 90_000, until: view => Date.parse(view.generatedAt) > Date.parse(before.generatedAt), label: `${member} new tool result`,
      });
      expect(after.name).toBe(before.name); expect(after.identity).toBe(before.identity); expect(after.meetings).toEqual(before.meetings);
      if (after.instanceId === before.instanceId) expect(after.generation).toBeGreaterThan(before.generation);
      else {
        expect(after.generation).toBeGreaterThanOrEqual(1);
        evidence.recordAssertionEvidence("Calendar generation reset across provider instances: disclosed demo limitation", JSON.stringify({ member, before, after }), true);
      }
      refreshed.push(after);
      await checkpoint(surface, `11-${member}-calendar-refreshed`);
      return after;
    });
  }
  const addedCity = await claim("World Clocks edit, native save confirmation, and fresh-tool persistence", async () => {
    await revealApp(alex, text(clockApp, "title"));
    await using clockFrame = await frame(alex, "World Clocks");
    await using clockApproval = await allowClockSaveDialog(alex, text(clockApp, "serverName"));
    await clickTarget(clockFrame, { role: "button", label: "Edit" });
    const existing = await evalIn(clockFrame, () => [...document.querySelectorAll(".wc-card__city")].map(node => node.textContent?.trim()));
    const city = ["Tokyo", "Paris", "Berlin", "Toronto", "Mumbai", "Cape Town"].find(city => !existing.includes(city));
    if (!city) throw new Error("No unused demo city remains; a no-op is not persistence proof");
    await clickTarget(clockFrame, { role: "combobox", label: "Add a city" });
    await fill(clockFrame, '[role="combobox"]', city);
    await clickTarget(clockFrame, { role: "option", label: new RegExp(city) });
    await see(clockFrame, city);
    expect(await evalIn(clockFrame, () => Number(document.querySelector<HTMLSelectElement>("#wc-limit")?.value))).toBe(existing.length + 1);
    await waitFor(clockFrame, () => /Saved \(shared with everyone\)|Saved to your account/.test(document.body.innerText),
      { timeoutMs: 30_000, label: "save_preferences acknowledged" });
    expect(clockApproval.observed.every(dialog => dialog.expected)).toBe(true);
    expect(clockApproval.approved(), "Real released-host write confirmation").toBeGreaterThan(0);
    evidence.recordAssertionEvidence("Accepted the exact native Clock save confirmation", JSON.stringify(clockApproval.observed), true);
    await evalIn(clockFrame, () => document.querySelector(".wc-footer")?.scrollIntoView({ block: "end" }));
    await checkpoint(alex, "12-world-clocks-edit-saved");
    await clickTarget(clockFrame, { role: "button", label: "Done" });
    await refresh(alex, text(clockApp, "title"));
    const persisted = await eventually(async () => {
      await using current = await frame(alex, "World Clocks");
      return await evaluate(current.client, () => ({
        cities: [...document.querySelectorAll(".wc-card__city")].map(node => node.textContent?.trim()),
        receipt: document.querySelector(".wc-footer")?.textContent?.trim(),
      }));
    }, { within: 60_000, intervalMs: 1_000, until: result => result.cities.includes(city), label: "fresh Clock result retains the saved city" });
    expect(persisted.cities).toContain(city);
    await using fresh = await frame(alex, "World Clocks");
    await evalIn(fresh, browserScript(city => [...document.querySelectorAll(".wc-card__city")]
      .find(node => node.textContent?.trim() === city)?.closest(".wc-card")?.scrollIntoView({ block: "center" }), [city]));
    await checkpoint(alex, "13-world-clocks-fresh-tool-persisted");
    expect(array(object(await readBoard()).item, "elements")).toEqual(elements);
    return city;
  });
  await writeFile(`${reportDirectory}observations.json`, JSON.stringify({ dashboardId, alex: a, jordan: j, refreshed, clockCity: addedCity, ...provenance }, null, 2));
  await writeClaims();
  expect(claimResults.filter(result => result.status !== "Passed"), JSON.stringify(claimResults)).toEqual([]);
  } catch (error) {
    if (claimResults.length === 0) {
      claimResults.push({ claim: "Required Den setup/Home sharing", status: "Failed", detail: error instanceof Error ? error.message : "Unknown setup failure" });
      claimResults.push({ claim: "Calendar and Clock phases", status: "Blocked", detail: "Required shared dashboard setup did not finish" });
      await writeClaims();
    }
    for (const [surface, name] of [[alex, "failed-alex-desktop"], [jordan, "failed-jordan-desktop"], [alexBrowser, "failed-alex-den-web"], [jordanBrowser, "failed-jordan-den-web"]] satisfies [Surface, string][]) {
      // Never photograph the authentication form or OAuth authorization URL.
      const safe = await evalIn(surface, () => !document.querySelector('input[type="password"]')
        && !/[?&](code|token|state)=/.test(location.search)
        && (location.hash.includes("/dashboard") || location.pathname.startsWith("/dashboard"))).catch(() => false);
      if (safe) await checkpoint(surface, name).catch(() => undefined);
    }
    throw error;
  } finally {
    await stack.disposeAsync();
    await assertReleaseSource();
  }
});
