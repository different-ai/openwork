import { expect } from "vitest";
import { eventually, spec } from "@openwork/testkit";
import { denDashboardActivity, isRecord, records } from "../worlds/den-dashboard-activity.ts";

const test = spec.world(denDashboardActivity, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

const activity = '[data-testid="dashboard-activity"]';
const rows = '[data-testid="dashboard-activity-row"]';

function stringField(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string") throw new Error(`Den did not return ${key}.`);
  return result;
}

test("an owner sees real workspace additions, keeps them during an outage, and does not change a member's home", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.web);
  const page = probe.on(world.web);
  const member = user.on(world.memberWeb);
  const memberPage = probe.on(world.memberWeb);
  const connectionTitle = `${world.names.connection} was added`;
  const rowTitles = async () => (await page.dom(`${rows} p:first-child`)).elements.map((entry) => entry.text);
  const ownHeaders = { "x-openwork-org-id": world.orgId };
  const connectionInventory = async () => {
    const response = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable", { headers: ownHeaders });
    expect(response.response.ok).toBe(true);
    return records(isRecord(response.body) ? response.body.connections : undefined);
  };

  await step("before: a slow connection read shows loading, not an empty history", async () => {
    try {
      await admin.see({ testId: "workspace-switcher-trigger" }, { text: /Activity workspace|Activity archive/, timeoutMs: 60_000 });
    } catch (error) {
      const requests = await world.faults.requests();
      evidence.recordAssertionEvidence("the owner can load the workspace directory", JSON.stringify(requests.map(({ path, status }) => ({ path, status }))), false);
      await admin.screenshot();
      await member.screenshot();
      throw error;
    }
    await admin.click({ testId: "workspace-switcher-trigger" });
    await admin.click({ role: "button", label: new RegExp(`^${world.names.workspace}`) });
    await admin.see({ role: "heading", label: "Activity" }, { timeoutMs: 60_000 });
    await world.faults.delay();
    await admin.navigate(`${world.baseUrl}/dashboard`);
    await admin.see({ testId: "dashboard-activity-loading" }, { timeoutMs: 90_000 });
    expect((await page.dom(`${activity} [role="status"]`)).elements).toHaveLength(1);
    expect((await page.dom(rows)).elements).toHaveLength(0);
    const loadingRows = (await page.dom('[data-testid="dashboard-activity-loading"] > div')).elements;
    expect(loadingRows.map((row) => row.rect.height)).toEqual([52, 52, 52, 52, 52]);
    await admin.notSee({ text: "Nothing new" });
    evidence.recordAssertionEvidence("loading is distinct from an empty history", "An 8-second delay on the real connection read leaves five 52px placeholders matching the populated rows; Nothing new is absent.", true);
    await admin.screenshot();
  });

  await step("before: an empty workspace offers one quiet way to add a connector", async () => {
    await admin.see({ text: "Nothing new" }, { timeoutMs: 60_000 });
    await admin.see({ role: "link", label: "Add a connector" });
    await admin.notSee({ role: "heading", label: "Quick add" });
    expect((await page.dom(rows)).elements).toHaveLength(0);
    expect((await page.dom(`${activity} a[href="/dashboard/mcp-connections/new"]`)).elements).toHaveLength(1);
    const delayed = (await world.faults.requests()).filter((request) => request.path.startsWith(world.activityPath) && request.faulted && request.status === 200);
    expect(delayed.length).toBeGreaterThan(0);
    expect(await connectionInventory()).toHaveLength(0);
    await world.faults.recover();
    evidence.recordAssertionEvidence("a successful empty read says Nothing new", `${delayed.length} delayed connection reads really completed with HTTP 200; the workspace has zero connections and the old Quick add heading is gone.`, true);
    await admin.screenshot();
  });

  const connection = await step("the owner adds a credential-free connector through the setup page", async () => {
    await admin.click({ role: "link", label: "Add a connector" });
    await admin.see({ role: "heading", label: "Add a connector" }, { timeoutMs: 60_000 });
    await admin.type({ placeholder: "Filter by name, or paste an MCP URL" }, world.names.connection);
    await admin.click({ testId: "connector-picker-no-match-add" });
    await admin.type({ label: "Address" }, world.connector.mcpUrl);
    await admin.see({ label: "Name" }, { value: world.names.connection });
    await admin.click({ role: "button", label: "Continue" });
    await admin.see({ role: "heading", label: `${world.names.connection} passed all 4 checks` }, { timeoutMs: 90_000 });
    await admin.click({ role: "button", label: `Add ${world.names.connection}` });
    await admin.see({ role: "heading", label: "Connectors" }, { timeoutMs: 60_000 });
    const saved = (await connectionInventory()).find((entry) => entry.name === world.names.connection);
    if (!saved) throw new Error("The connector created through the page is missing from Den.");
    const id = stringField(saved, "id");
    const createdAt = stringField(saved, "createdAt");
    expect(Number.isFinite(Date.parse(createdAt))).toBe(true);
    expect(saved.authType).toBe("none");
    const requests = await world.connector.requests();
    expect(requests.some((request) => request.path.startsWith("/mcp"))).toBe(true);
    expect(requests.filter((request) => request.path === "/authorize" || request.path === "/token")).toHaveLength(0);
    evidence.recordAssertionEvidence("the setup persisted a real connector without provider credentials", `Den saved ${id}, authType=none, createdAt=${createdAt}; the mock MCP server received discovery traffic and no authorization or token request.`, true);
    await admin.screenshot();
    return { id, createdAt };
  });

  await step("after: Activity shows the new connection with its stored creation time", async () => {
    await admin.navigate(`${world.baseUrl}/dashboard`);
    await admin.see({ testId: "dashboard-activity-row" }, { text: new RegExp(connectionTitle), timeoutMs: 60_000 });
    expect(await rowTitles()).toEqual([connectionTitle]);
    expect((await page.dom(`${rows} p:nth-child(2)`)).elements.map((entry) => entry.text)).toEqual(["Connection"]);
    expect((await page.dom(`${rows} time[data-activity-time][datetime="${connection.createdAt}"]`)).elements).toHaveLength(1);
    expect((await page.dom(`${rows} a[href="/dashboard/mcp-connections/${connection.id}"]`)).elements).toHaveLength(1);
    await admin.notSee({ text: "Nothing new" });
    evidence.recordAssertionEvidence("the addition uses Den's date and connector destination", `One row reads “${connectionTitle}”, detail Connection; its time is ${connection.createdAt} and Open points to /dashboard/mcp-connections/${connection.id}.`, true);
    await admin.screenshot();
  });

  await step("Open takes the owner to the connection they just added", async () => {
    await admin.click({ role: "link", label: `Open: ${connectionTitle}` });
    await admin.see({ testId: "admin-connector-page" }, { timeoutMs: 60_000 });
    await admin.see({ role: "heading", label: world.names.connection });
    const saved = (await connectionInventory()).find((entry) => entry.id === connection.id);
    expect(saved?.createdAt).toBe(connection.createdAt);
    evidence.recordAssertionEvidence("Open resolves the real connector", `The connector page shows ${world.names.connection}; reading it did not change its creation time ${connection.createdAt}.`, true);
    await admin.screenshot();
  });

  await step("after: an outage leaves the last successful activity visible", async () => {
    await admin.navigate(`${world.baseUrl}/dashboard`);
    await admin.see({ testId: "dashboard-activity-row" }, { text: new RegExp(connectionTitle), timeoutMs: 60_000 });
    await world.faults.fail();
    // Reopening this workspace remounts the dashboard and refreshes its cached
    // snapshot through the real UI; no timer or synthetic Query event is needed.
    await admin.click({ testId: "workspace-switcher-trigger" });
    await admin.click({ role: "button", label: new RegExp(`^${world.names.workspace}`) });
    await admin.see({ text: /Couldn’t refresh\. Showing activity from .+\./ }, { timeoutMs: 60_000 });
    expect(await rowTitles()).toEqual([connectionTitle]);
    await admin.notSee({ testId: "dashboard-activity-loading" });
    await admin.notSee({ text: "Nothing new" });
    const failed = (await world.faults.requests()).filter((request) => request.path.startsWith(world.activityPath) && request.faulted && request.status === 503);
    expect(failed.length).toBeGreaterThan(0);
    const retry = (await page.dom(`${activity} [role="status"] button`)).elements[0];
    const open = (await page.dom(`${rows} a`)).elements[0];
    expect(retry?.rect.right).toBe(open?.rect.right);
    expect(retry?.rect.height).toBeGreaterThanOrEqual(24);
    evidence.recordAssertionEvidence("a failed refresh does not erase a successful snapshot", `${failed.length} real HTTP 503 responses; the page keeps ${connectionTitle} and its date. Retry shares Open's right edge with a ${retry?.rect.height}px hit area.`, true);
    await admin.screenshot();
  });

  await step("Retry keeps the old row even while the service is still unavailable", async () => {
    const failedCount = async () => (await world.faults.requests()).filter((request) => request.path.startsWith(world.activityPath) && request.status === 503).length;
    const before = await failedCount();
    await admin.click({ role: "button", label: "Retry" });
    expect(await rowTitles()).toEqual([connectionTitle]);
    await eventually(async () => await failedCount() > before, { within: 15_000, label: "Retry to reach the unavailable connection service" });
    await admin.see({ text: /Couldn’t refresh\. Showing activity from .+\./ });
    expect(await rowTitles()).toEqual([connectionTitle]);
    evidence.recordAssertionEvidence("Retry really retries without clearing the row", `Failed connection reads increased from ${before} to ${await failedCount()}; the previous activity row stayed visible before and after the request.`, true);
    await admin.screenshot();
  });

  await step("after: Retry restores a fresh activity view when the service recovers", async () => {
    await world.faults.recover();
    await admin.click({ role: "button", label: "Retry" });
    await eventually(async () => !(await page.has("Couldn’t refresh")), { within: 30_000, label: "the successful retry to clear the stale warning" });
    await admin.notSee({ text: /Couldn’t refresh/ });
    expect(await rowTitles()).toEqual([connectionTitle]);
    expect((await page.dom(`${rows} time[data-activity-time][datetime="${connection.createdAt}"]`)).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("recovery removes the warning without changing the event date", `Retry succeeded; the sole row still uses the stored creation time ${connection.createdAt}, not the retry time.`, true);
    await admin.screenshot();
  });

  await step("a first-load outage does not pretend that nothing has happened", async () => {
    await world.faults.fail();
    await admin.reload();
    await admin.see({ text: "Couldn’t refresh." }, { timeoutMs: 60_000 });
    await admin.see({ role: "button", label: "Retry" });
    await admin.notSee({ text: "Nothing new" });
    await admin.notSee({ text: /Showing activity from/ });
    expect((await page.dom(rows)).elements).toHaveLength(0);
    const saved = (await connectionInventory()).find((entry) => entry.id === connection.id);
    expect(saved?.createdAt).toBe(connection.createdAt);
    evidence.recordAssertionEvidence("no successful snapshot means an error, not an empty claim", `The browser has no cached rows after reload and reports only Couldn’t refresh.; Den still contains ${connection.id}.`, true);
    await admin.screenshot();
    await world.faults.recover();
    await admin.click({ role: "button", label: "Retry" });
    await admin.see({ testId: "dashboard-activity-row" }, { text: new RegExp(connectionTitle), timeoutMs: 30_000 });
  });

  await step("another workspace shows only its five latest additions and skill versions", async () => {
    await admin.click({ testId: "workspace-switcher-trigger" });
    await admin.click({ role: "button", label: new RegExp(`^${world.names.otherWorkspace}`) });
    await admin.see({ testId: "dashboard-activity-row" }, { text: /Archive connector|A new version of/, timeoutMs: 60_000 });
    await admin.notSee({ text: connectionTitle });
    const headers = { "x-openwork-org-id": world.otherOrgId };
    const listed = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable", { headers });
    const versions = await probe.api(world.den.admin, `/v1/config-objects/${world.skillId}/versions?limit=5&includeDeleted=false`, { headers });
    expect(listed.response.ok && versions.response.ok).toBe(true);
    const connections = records(isRecord(listed.body) ? listed.body.connections : undefined);
    const savedVersions = records(isRecord(versions.body) ? versions.body.items : undefined);
    expect(connections).toHaveLength(7);
    expect(savedVersions).toHaveLength(2);
    expect(connections.some((entry) => entry.id === connection.id)).toBe(false);
    const events = [
      ...connections.map((entry) => ({
        id: `connection:${stringField(entry, "id")}`, title: `${stringField(entry, "name")} was added`, createdAt: stringField(entry, "createdAt"),
      })),
      ...savedVersions.map((entry) => ({
        id: `skill:${stringField(entry, "id")}`, title: `A new version of ${world.skillTitle} was published`, createdAt: stringField(entry, "createdAt"),
      })),
    ].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.id.localeCompare(right.id)).slice(0, 5);
    expect(await rowTitles()).toEqual(events.map((entry) => entry.title));
    for (const [index, event] of events.entries()) {
      expect((await page.dom(`${rows}:nth-child(${index + 1}) time[data-activity-time][datetime="${event.createdAt}"]`)).elements).toHaveLength(1);
    }
    expect((await page.dom(`${rows} a[href="/dashboard/plugins/${world.pluginId}/skills/${world.skillId}"]`)).elements).toHaveLength(2);
    const renderedRows = (await page.dom(rows)).elements;
    const times = (await page.dom(`${rows} [data-activity-time]`)).elements;
    const actions = (await page.dom(`${rows} > span:last-child`)).elements;
    const marks = (await page.dom(`${rows} > span:first-child`)).elements;
    const titles = (await page.dom(`${rows} p:first-child`)).elements;
    expect(renderedRows.map((row) => row.rect.height)).toEqual([52, 52, 52, 52, 52]);
    expect(marks.map((mark) => mark.rect.width)).toEqual([24, 24, 24, 24, 24]);
    expect(titles.map((title) => title.rect.height)).toEqual([18, 18, 18, 18, 18]);
    expect(times.map((time) => time.rect.width)).toEqual([64, 64, 64, 64, 64]);
    expect(actions.map((action) => action.rect.width)).toEqual([72, 72, 72, 72, 72]);
    expect(new Set(times.map((time) => time.rect.right)).size).toBe(1);
    expect(new Set(actions.map((action) => action.rect.right)).size).toBe(1);
    evidence.recordAssertionEvidence("the five newest events are scoped to the selected workspace", `Seven stored connections and two stored skill versions produce five 52px rows with aligned 64px time and 72px action lanes: ${events.map((entry) => `${entry.title} (${entry.createdAt})`).join("; ")}. The first workspace's connector is absent.`, true);
    await admin.screenshot();
  });

  await step("switching back does not leak the other workspace's cached activity", async () => {
    await admin.click({ testId: "workspace-switcher-trigger" });
    await admin.click({ role: "button", label: new RegExp(`^${world.names.workspace}`) });
    await admin.see({ testId: "dashboard-activity-row" }, { text: new RegExp(connectionTitle), timeoutMs: 60_000 });
    expect(await rowTitles()).toEqual([connectionTitle]);
    await admin.notSee({ text: /Archive connector/ });
    await admin.notSee({ text: `A new version of ${world.skillTitle} was published` });
    evidence.recordAssertionEvidence("the original workspace restores only its own addition", `Switching back shows only ${connectionTitle}; none of the other workspace's nine events appear.`, true);
    await admin.screenshot();
  });

  await step("a workspace outside the rollout keeps Quick add and its existing connections", async () => {
    await admin.click({ testId: "workspace-switcher-trigger" });
    await admin.click({ role: "button", label: new RegExp(`^${world.names.disabledWorkspace}`) });
    await admin.see({ role: "heading", label: "Quick add" }, { timeoutMs: 60_000 });
    await admin.see({ role: "heading", label: /From your workspace suite/i }, { timeoutMs: 60_000 });
    await admin.see({ role: "heading", label: /MCP servers/i }, { timeoutMs: 60_000 });
    await admin.screenshot();
    await admin.notSee({ testId: "dashboard-activity" });
    const context = await probe.api(world.den.admin, "/v1/org", { headers: { "x-openwork-org-id": world.disabledOrgId } });
    expect(context.response.ok).toBe(true);
    expect(isRecord(context.body) && isRecord(context.body.features) && context.body.features.dashboardActivity).toBe(false);
    const stored = await probe.api(world.den.admin, `/v1/mcp-connections/${world.disabledConnectionId}`, { headers: { "x-openwork-org-id": world.disabledOrgId } });
    expect(stored.response.ok).toBe(true);
    expect(isRecord(stored.body) && stored.body.name).toBe("Retained connection");
    const typography = await world.ownerTypography();
    expect(typography.quickAddHeadings.map((heading) => heading.text)).toEqual(["From your workspace suite", "MCP servers"]);
    expect(typography.sidebarLabels.map((label) => label.text)).toEqual(["Work", "Manage", "Observability", "Team"]);
    expect(typography.sidebarBadges.some((badge) => badge.text === "MCPs")).toBe(true);
    for (const heading of typography.quickAddHeadings) {
      expect(heading.fontSize).toBeGreaterThanOrEqual(12);
      expect(heading.fontSize).toBeLessThanOrEqual(13);
    }
    for (const label of [...typography.sidebarLabels, ...typography.sidebarBadges]) {
      expect(label.fontSize).toBeGreaterThanOrEqual(11);
      expect(label.fontSize).toBeLessThanOrEqual(13);
    }
    for (const label of [...typography.quickAddHeadings, ...typography.sidebarLabels]) {
      expect(label.fontWeight).toBe(500);
      expect(label.textTransform).toBe("none");
      expect(label.letterSpacing).toBe(0);
    }
    for (const label of [...typography.quickAddHeadings, ...typography.sidebarLabels, ...typography.sidebarBadges]) {
      expect(label.contrast).toBeGreaterThanOrEqual(4.5);
    }
    const measured = [...typography.quickAddHeadings, ...typography.sidebarLabels, ...typography.sidebarBadges]
      .map((label) => `${label.text}: ${label.fontSize}px, ${label.contrast.toFixed(2)}:1`).join("; ");
    evidence.recordAssertionEvidence("the feature-off workspace keeps readable labels and its stored connector", `Den reports dashboardActivity=false; Quick add and Retained connection remain, Activity is absent. Section headings have no uppercase transform or tracking. Rendered typography: ${measured}.`, true);
    await admin.screenshot();
  });

  await step("after: the member gets a readable installation home, not the admin activity feed", async () => {
    await member.reload();
    await member.see({ testId: "member-dashboard" }, { timeoutMs: 60_000 });
    await member.see({ role: "heading", label: `${world.names.workspace} is set up for you` });
    await member.see({ testId: "member-download-app" }, { text: "Get OpenWork" });
    await member.see({ role: "link", label: "Download OpenWork" });
    await member.see({ role: "link", label: "Open OpenWork" });
    await member.see({ text: "Your team's models and plugins are included when you sign in." });
    await member.notSee({ testId: "dashboard-activity" });
    await member.notSee({ text: connectionTitle });
    await member.notSee({ text: /Your download is already preconfigured/ });
    const context = await probe.api(world.den.members.member, "/v1/org", { headers: ownHeaders });
    expect(context.response.ok).toBe(true);
    expect(isRecord(context.body) && isRecord(context.body.organization) && context.body.organization.name).toBe(world.names.workspace);
    expect(world.names.workspace.length).toBeGreaterThanOrEqual(80);
    const typography = await world.memberTypography();
    expect(typography.memberHeadings).toHaveLength(1);
    const heading = typography.memberHeadings[0];
    expect(heading.text).toBe(`${world.names.workspace} is set up for you`);
    expect(heading.textNodes).toBe(1);
    expect(heading.fontSize).toBeGreaterThan(0);
    expect(heading.fontSize).toBeLessThanOrEqual(20);
    expect(heading.fontWeight).toBe(600);
    expect(heading.textTransform).toBe("none");
    expect(heading.letterSpacing).toBeLessThan(0);
    const home = (await memberPage.dom('[data-testid="member-dashboard"]')).elements[0];
    expect(home.text).not.toMatch(/[·→]/);
    expect((await memberPage.dom('[data-testid="member-dashboard"] > div > p:first-child')).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("the member's real workspace name uses one compact heading and keeps both install actions", `Den stores the ${world.names.workspace.length}-character workspace name. The ${heading.fontSize}px heading is one text node, without an eyebrow or decorative dots/arrows; Get OpenWork, header Download, and sign-in context remain. No admin Activity section or connection-added row is rendered.`, true);
    await member.screenshot();
  });

  for (const width of [320, 390]) {
    await step(`after: the member's long workspace name wraps and Get OpenWork stays reachable at ${width}px`, async () => {
      await member.resizeViewport({ width, height: 844, deviceScaleFactor: 1 });
      await member.see({ role: "heading", label: `${world.names.workspace} is set up for you` });
      await member.see({ testId: "member-download-app", role: "button", label: "Get OpenWork" });
      await member.see({ testId: "den-download-openwork", role: "link", label: "Download OpenWork" });
      await member.see({ role: "link", label: "Open OpenWork" });
      // hover uses the browser's real hit test: fitting a rectangle alone would
      // not prove that the button is reachable rather than covered by the shell.
      await member.hover({ testId: "member-download-app" });
      await member.notSee({ testId: "dashboard-activity" });
      await member.notSee({ text: connectionTitle });
      const geometry = await memberPage.dom('main, [data-testid="member-dashboard"], [data-testid="member-dashboard"] h1, [data-testid="member-download-app"], header [data-testid="den-download-openwork"]');
      expect(geometry.viewportWidth).toBe(width);
      expect(geometry.documentWidth).toBeLessThanOrEqual(width);
      for (const element of geometry.elements) {
        expect(element.rect.left).toBeGreaterThanOrEqual(0);
        expect(element.rect.right).toBeLessThanOrEqual(width);
      }
      const heading = (await memberPage.dom('[data-testid="member-dashboard"] h1')).elements[0];
      const button = (await memberPage.dom('[data-testid="member-download-app"]')).elements[0];
      expect(heading.rect.height).toBeGreaterThan(40);
      expect(button.rect.width).toBeGreaterThan(0);
      expect(button.rect.height).toBeGreaterThanOrEqual(24);
      expect(button.rect.top).toBeGreaterThanOrEqual(52);
      expect(button.rect.bottom).toBeLessThanOrEqual(844);
      const typography = await world.memberTypography();
      expect(typography.memberHeadings[0].fontSize).toBeLessThanOrEqual(20);
      expect(typography.memberHeadings[0].textNodes).toBe(1);
      evidence.recordAssertionEvidence("the narrow member home has no horizontal overflow or covered download button", `Viewport=${width}px; document=${geometry.documentWidth}px; the real workspace heading wraps to ${heading.rect.height}px. Get OpenWork is ${button.rect.width}×${button.rect.height}px at y=${button.rect.top}..${button.rect.bottom}, inside the first viewport and reachable by the real pointer hit test. Header Download remains; admin activity is absent.`, true);
      await member.screenshot();
    });
  }
});
