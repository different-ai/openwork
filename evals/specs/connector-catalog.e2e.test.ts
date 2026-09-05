import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { allConnectorsPrompt, allConnectorsReply, connectorCatalogDiscovery, connectorCatalogPrompt, connectorCatalogReply, connectorsQuickAdd, isRecord, records } from "../worlds/library.ts";

const test = spec.world(connectorCatalogDiscovery, { timeout: 600_000 });

const catalogTest = spec.world(connectorsQuickAdd, { timeout: 600_000 });

catalogTest("Den catalog shows its full inventory, preserves service identity, and keeps account readiness personal", async ({ world, user, probe, step }) => {
  const admin = user.on(world.web);
  const member = user.on(world.memberWeb);
  const catalog = probe.on(world.web);
  const catalogUrl = `${world.den.ref.webUrl}/dashboard/mcp-connections`;
  const presetResponse = await probe.api(world.den.admin, "/v1/mcp-connections/presets");
  expect(presetResponse.response.ok).toBe(true);
  if (!isRecord(presetResponse.body)) throw new Error("Den returned no preset inventory.");
  const presets = records(presetResponse.body.presets);
  const presetIds = presets.map((entry) => entry.presetId);
  expect(presetIds).toEqual(expect.arrayContaining(["github", "notion", "slack", "context7", "exa"]));
  expect(new Set(presetIds).size).toBe(presetIds.length);
  const popularIds = ["gmail", "github", "google-drive", "google-calendar", "notion", "slack"];
  const expectedIds = [...popularIds, "microsoft-365", ...presetIds.filter((id) => !popularIds.includes(String(id)))];
  const before = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
  expect(before.response.ok).toBe(true);
  const requestsBefore = (await world.connector.requests()).filter((entry) => entry.path === "/authorize" || entry.path === "/token");

  await step("browse every integration with an accurate total and setup requirements", async () => {
    await admin.see({ testId: "connector-catalog-count" }, { text: `Showing 6 of ${expectedIds.length} integrations`, timeoutMs: 90_000 });
    await admin.see({ role: "button", label: "Set up Slack" });
    await admin.see({ role: "button", label: "Connect Notion" });
    await admin.click({ testId: "connector-catalog-more" });
    const facts = await catalog.connectorCatalog();
    expect(facts.entries.map((entry) => entry.id)).toEqual(expectedIds);
    expect(facts.summary).toBe(`Showing ${expectedIds.length} of ${expectedIds.length} integrations`);
    expect(facts.horizontalOverflow).toBe(false);
    expect(facts.entries.find((entry) => entry.id === "slack")?.status).toBe("OAuth app required");
    expect(facts.entries.find((entry) => entry.id === "exa")?.status).toBe("API key");
    expect(facts.entries.find((entry) => entry.id === "context7")?.status).toBe("Instant — no sign-in");
    for (const entry of facts.entries) {
      expect(entry.text.trim().length).toBeGreaterThan(entry.id.length);
      expect(entry.href).toContain(`/mcp-connections/${entry.id}`);
      expect(entry.status.length).toBeGreaterThan(0);
    }
    await admin.screenshot();
  });

  await step("filter the full inventory and recover from an empty result", async () => {
    await admin.type({ testId: "connector-smart-bar" }, "granola", { replace: true });
    await admin.see({ testId: "connector-catalog-count" }, { text: `1 of ${expectedIds.length} integrations match` });
    expect((await catalog.connectorCatalog()).entries.map((entry) => entry.id)).toEqual(["granola"]);
    await admin.type({ testId: "connector-smart-bar" }, "catalog-no-match", { replace: true });
    await admin.see({ testId: "connector-catalog-count" }, { text: `0 of ${expectedIds.length} integrations match` });
    expect((await catalog.connectorCatalog()).entries).toEqual([]);
    await admin.type({ testId: "connector-smart-bar" }, "gmail", { replace: true });
    await admin.click({ testId: "connector-open-gmail" });
    await admin.see({ role: "heading", label: "Gmail" });
    await admin.see({ testId: "connector-detail-state" }, { text: "Needs your account" });
    await admin.reload();
    await admin.see({ role: "heading", label: "Gmail" });
    await admin.see({ text: "one connection covers Gmail, Drive, and Calendar" });
    await admin.screenshot();
    for (const [id, label] of [["google-drive", "Google Drive"], ["google-calendar", "Google Calendar"]]) {
      await admin.navigate(catalogUrl);
      await admin.click({ testId: `connector-open-${id}` });
      await admin.see({ role: "heading", label });
    }
    const after = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    expect(after.body).toEqual(before.body);
    expect((await world.connector.requests()).filter((entry) => entry.path === "/authorize" || entry.path === "/token")).toEqual(requestsBefore);
    expect(await probe.toolCalls(world.connector)).toEqual([]);
  });

  await step("a member connects without making the admin personally connected", async () => {
    await member.see({ text: "Catalog Notes" }, { timeoutMs: 90_000 });
    await member.click({ role: "button", label: "Connect", nth: 0 });
    await member.see({ testId: `disconnect-my-mcp-account-${world.connection.id}` }, { timeoutMs: 120_000 });
    const memberState = await probe.api(world.den.members.member, "/v1/mcp-connections?scope=usable");
    if (!isRecord(memberState.body)) throw new Error("Den returned no member connections.");
    expect(records(memberState.body.connections).find((entry) => entry.id === world.connection.id)).toMatchObject({ connectedForMe: true });
    await admin.navigate(`${catalogUrl}/${world.connection.id}`);
    await admin.see({ testId: "connector-detail-state" }, { text: "Needs your account" });
    await admin.notSee({ testId: "connector-detail-test-tools" });
    const adminState = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    if (!isRecord(adminState.body)) throw new Error("Den returned no admin connections.");
    expect(records(adminState.body.connections).find((entry) => entry.id === world.connection.id)).toMatchObject({ connectedForMe: false, connected: true });
    await admin.screenshot();
  });
});

test("chat suggests Slack setup and lets an admin browse every quick-add connector", async ({ world, agent, user, probe, evidence }) => {
  const appUser = user.on(world.app);
  const appProbe = probe.on(world.app);
  const webUser = user.on(world.web);
  expect(connectorCatalogPrompt).not.toContain(world.connection.id);
  await agent.on(world.app).send(connectorCatalogPrompt);
  await appUser.see({ text: connectorCatalogReply, connectorsQuickAdd, isRecord, records }, { timeoutMs: 120_000 });
  await appUser.see({ testId: "connector-catalog" });
  await appUser.see({ role: "button", label: "Set up Slack" });
  await appUser.see({ text: "Admin setup" });
  await appUser.notSee({ testId: "desktop-connection-card" });
  const visibleIds = () => appProbe.eval(`Array.from(document.querySelectorAll('[data-connector-preset]'), element => element.getAttribute('data-connector-preset'))`);
  expect(await visibleIds()).toEqual(["slack"]);
  const suggestedWidth = await appProbe.eval(`document.querySelector('[data-testid="connector-catalog"]')?.getBoundingClientRect().width`);
  await appUser.screenshot();
  evidence.recordAssertionEvidence("A Slack request offers setup without claiming the service is connected", "Only Slack is suggested with Admin setup; no account connection card is shown", true);

  await appUser.click({ role: "button", label: `Browse all ${world.expectedIds.length}` });
  await appUser.see({ role: "textbox", label: "Filter connectors" });
  expect(await visibleIds()).toEqual(world.expectedIds);
  const expandedWidth = await appProbe.eval(`document.querySelector('[data-testid="connector-catalog"]')?.getBoundingClientRect().width`);
  expect(expandedWidth).toBe(suggestedWidth);
  evidence.recordAssertionEvidence("Browsing all connectors preserves the suggestion card width", JSON.stringify({ suggestedWidth, expandedWidth }), true);
  await appUser.see({ role: "button", label: "Set up Linear" });
  await appUser.screenshot();
  evidence.recordAssertionEvidence("Browse all includes the complete Den preset catalog and both productivity suites", JSON.stringify(world.expectedIds), true);
  await appUser.type({ role: "textbox", label: "Filter connectors" }, "no such connector", { replace: true });
  await appUser.see({ text: "No connectors match your search." });
  expect(await visibleIds()).toEqual([]);
  await appUser.type({ role: "textbox", label: "Filter connectors" }, "slack", { replace: true });
  expect(await visibleIds()).toEqual(["slack"]);
  await probe.eventually(
    () => appProbe.eval(`document.querySelector('button[aria-label="Set up Slack"]')?.disabled === false`),
    { within: 15_000, label: "admin setup action is enabled", until: value => value === true },
  );
  expect(await world.browserUrls.opened()).toEqual([]);
  await appUser.click({ role: "button", label: "Set up Slack" });
  await appUser.notSee({ role: "alert" });

  // Observe the URL Electron actually handed to the OS before bridging that
  // exact handoff into our signed-in browser. A no-op or wrong URL fails here.
  const openedUrls = await probe.eventually(() => world.browserUrls.opened(), {
    within: 30_000, label: "Slack setup asks the OS to open its destination", until: urls => urls.length > 0,
  });
  expect(openedUrls).toHaveLength(1);
  const openedUrl = openedUrls[0];
  if (!openedUrl) throw new Error("Slack setup did not open a URL");
  const setupUrl = new URL(openedUrl);
  expect(setupUrl.origin).toBe(new URL(world.den.ref.webUrl).origin);
  expect(setupUrl.pathname).toBe("/dashboard/mcp-connections");
  expect([...setupUrl.searchParams.entries()]).toEqual([["quickAdd", "slack"]]);
  await webUser.navigate(openedUrl);
  await webUser.see({ text: "OAuth app" }, { timeoutMs: 90_000 });
  await webUser.see({ text: "Client ID (optional for now)" });
  await webUser.see({ text: "Client secret (optional for now)" });
  await webUser.screenshot();
  const calls = await world.den.mocks.connector.agentRequests({ promptMarker: connectorCatalogPrompt });
  expect(calls.filter(call => call.kind === "tool")).toHaveLength(1);
  expect(calls.filter(call => call.kind === "tool").every(call => call.toolName?.endsWith("search_capabilities"))).toBe(true);
  expect((await world.den.mocks.connector.requests()).filter(request => request.path === "/authorize")).toHaveLength(0);
  await appUser.click({ role: "button", label: "New session" });
  await appUser.see({ text: "Try one of these:" });
  await agent.on(world.app).send(allConnectorsPrompt);
  await appUser.see({ text: allConnectorsReply }, { timeoutMs: 120_000 });
  const listed = await appProbe.eval(`(() => {
    const cards = Array.from(document.querySelectorAll('[data-testid="connector-catalog"]'));
    return Array.from(cards.at(-1)?.querySelectorAll('[data-connector-preset]') ?? [], entry => entry.getAttribute('data-connector-preset'));
  })()`);
  expect(listed).toEqual(world.expectedIds);
  await appUser.screenshot();
  evidence.recordAssertionEvidence("Asking for all quick adds immediately opens the complete catalog", JSON.stringify(listed), true);
  evidence.recordAssertionEvidence("Filtering selects Slack and its setup destination opens the OAuth client form", "Clicking Set up Slack emitted exactly one OS browser request for the expected Den origin, connector page, and quickAdd=slack. Navigating that captured URL renders client fields; the agent only searched and did not execute setup or authorize an account", true);
});
