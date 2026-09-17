import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { allConnectorsPrompt, allConnectorsReply, connectorCatalogDiscovery, connectorCatalogPrompt, connectorCatalogReply } from "../worlds/library.ts";

const test = spec.world(connectorCatalogDiscovery, { timeout: 600_000 });

test("connector setup requests stay ordinary tool lines while Den catalog Chat links remain available", async ({ world, seed, agent, user, probe, evidence, step }) => {
  const appUser = user.on(world.app);
  const appProbe = probe.on(world.app);
  const webUser = user.on(world.web);
  const beforeRequests = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
  expect(beforeRequests.response.ok).toBe(true);
  const browserUrlsBefore = await world.browserUrls.opened();

  for (const request of [
    { prompt: connectorCatalogPrompt, reply: connectorCatalogReply, query: "Slack", ids: world.expectedIds },
    { prompt: allConnectorsPrompt, reply: allConnectorsReply, query: "quick add connectors", ids: world.expectedIds },
  ]) {
    await step(`${request.query} returns an ordinary result without a catalog card`, async () => {
      expect(request.prompt).not.toContain(world.connection.id);
      await agent.on(world.app).send(request.prompt);
      await appUser.see({ text: request.reply }, { timeoutMs: 120_000 });
      await appUser.see({ role: "button", label: `Searched your connections for “${request.query}”. Show technical details` });
      await appUser.notSee({ testId: "connector-catalog" });
      await appUser.notSee({ testId: "desktop-connection-card" });
      await appUser.notSee({ role: "button", label: "Set up Slack" });
      await appUser.notSee({ role: "textbox", label: "Filter connectors" });
      await appUser.notSee({ role: "button", label: /^Browse all/ });
      expect(await appProbe.eval(() => document.querySelectorAll('[data-capability-call$="search_capabilities"]').length)).toBe(1);
      await appUser.screenshot();
      await appUser.click({ role: "button", label: `Searched your connections for “${request.query}”. Show technical details` });
      await appUser.see({ text: /"connectorCatalog"\s*:/ });
      await appUser.see({ text: request.query === "Slack" ? /"selectedIds"\s*:\s*\[\s*"slack"\s*\]/ : /"selectedIds"\s*:\s*\[\s*\]/ });
      for (const id of request.ids) await appUser.see({ text: new RegExp(`quickAdd=${id}`) });
      await appUser.notSee({ text: /"connectors"\s*:/ });
      await appUser.click({ role: "button", label: `Searched your connections for “${request.query}”. Hide technical details` });
      const calls = await world.den.mocks.connector.agentRequests({ promptMarker: request.prompt });
      expect(calls.filter(call => call.kind === "tool")).toHaveLength(1);
      expect(calls.filter(call => call.kind === "tool").every(call => call.toolName?.endsWith("search_capabilities"))).toBe(true);
      expect(await probe.toolCalls(world.den.mocks.connector)).toEqual([]);
      expect((await world.den.mocks.connector.requests()).filter(entry => entry.path === "/authorize" || entry.path === "/token")).toEqual([]);
      expect(await world.browserUrls.opened()).toEqual(browserUrlsBefore);
      expect((await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable")).body).toEqual(beforeRequests.body);
      evidence.recordAssertionEvidence("Setup discovery uses an ordinary tool line without connecting or opening a catalog", `${request.query} returned legacy connector metadata and setup URLs in technical details without modern catalog UI; one search, no provider calls, no OAuth, no browser handoff, and no connection mutation.`, true);
    });
    await appUser.click({ role: "button", label: "New session" });
    await appUser.see("composer", { editable: true });
    await probe.eventually(() => appProbe.composer(), {
      within: 15_000, label: "new session has an empty transcript", until: state => state.userMessageCount === 0 && state.assistantMessageCount === 0,
    });
  }

  await step("unconfigured catalog and detail Chat links seed a draft without sending or connecting", async () => {
    const webProbe = probe.on(world.web);
    const before = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    expect(before.response.ok).toBe(true);
    const modelRequests = await world.den.mocks.connector.agentRequests();
    const authRequests = (await world.den.mocks.connector.requests()).filter((entry) => entry.path === "/authorize" || entry.path === "/token");
    const openedBefore = await world.browserUrls.opened();
    await webUser.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections`);
    await webUser.see({ testId: "connector-add-slack" }, { timeoutMs: 90_000 });
    await webUser.see({ testId: "connector-chat-slack" });
    const catalogLink = (await webProbe.connectorCatalog()).chatLinks.find((link) => link.testId === "connector-chat-slack");
    if (!catalogLink) throw new Error("Unconfigured Slack has no catalog Chat link.");
    await webUser.click({ testId: "connector-open-slack" });
    await webUser.see({ testId: "connector-detail-chat" });
    await webUser.see({ testId: "connector-detail-setup" }, { text: "Set up" });
    const detailLink = (await webProbe.connectorCatalog()).chatLinks.find((link) => link.testId === "connector-detail-chat");
    expect(detailLink?.href).toBe(catalogLink.href);
    const link = new URL(catalogLink.href);
    expect(`${link.protocol}//${link.host}`).toBe("openwork://chat");
    expect(link.searchParams.get("connector")).toBe("Slack");
    expect([...link.searchParams.keys()].sort()).toEqual(["connector", "prompt"]);
    const prompt = link.searchParams.get("prompt");
    if (!prompt) throw new Error("Chat link has no starter prompt.");
    expect(prompt).not.toContain(world.connection.id);
    // Bridge only OS delivery. The real desktop listener must parse the rendered link and seed its own composer.
    await seed.deepLink(world.app, catalogLink.href);
    await appUser.see("composer", { editable: true, text: new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    const composer = await appProbe.composer();
    expect(composer.draftText).toContain("Slack");
    expect(composer.draftText).toContain(prompt);
    expect(composer.userMessageCount).toBe(0);
    expect(composer.assistantMessageCount).toBe(0);
    await appUser.notSee({ testId: "desktop-connection-card" });
    await appUser.notSee({ testId: "connector-catalog" });
    expect((await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable")).body).toEqual(before.body);
    expect(await world.den.mocks.connector.agentRequests()).toEqual(modelRequests);
    expect((await world.den.mocks.connector.requests()).filter((entry) => entry.path === "/authorize" || entry.path === "/token")).toEqual(authRequests);
    expect(await probe.toolCalls(world.den.mocks.connector)).toEqual([]);
    expect(await world.browserUrls.opened()).toEqual(openedBefore);
    await appUser.screenshot();
  });
});
