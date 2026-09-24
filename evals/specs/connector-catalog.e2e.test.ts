import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { allConnectorsPrompt, allConnectorsReply, connectorCatalogDiscovery, connectorCatalogPrompt, connectorCatalogReply } from "../worlds/library.ts";

const test = spec.world(connectorCatalogDiscovery, {
  timeout: 600_000,
  resources: { surfaces: ["desktop", "web"], services: ["den", "mock"], nativeReason: "The catalog Chat link must reach the desktop OS deep-link listener without sending a message." },
});

test("a member gets setup links without starting OAuth or creating connections", async ({ world, seed, agent, user, probe, evidence, step }) => {
  const appUser = user.on(world.app);
  const appProbe = probe.on(world.app);
  const webUser = user.on(world.web);
  const beforeRequests = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
  expect(beforeRequests.response.ok).toBe(true);

  for (const request of [
    { prompt: connectorCatalogPrompt, reply: connectorCatalogReply, query: "Slack" },
    { prompt: allConnectorsPrompt, reply: allConnectorsReply, query: "quick add connectors" },
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
      await appUser.screenshot();
      await appUser.click({ role: "button", label: `Searched your connections for “${request.query}”. Show technical details` });
      await appUser.see({ text: /"connectorCatalog"\s*:/ });
      await appUser.see({ text: request.query === "Slack" ? /"selectedIds"\s*:\s*\[\s*"slack"\s*\]/ : /"selectedIds"\s*:\s*\[\s*\]/ });
      for (const id of world.expectedIds) await appUser.see({ text: new RegExp(`quickAdd=${id}`) });
      await appUser.notSee({ text: /"connectors"\s*:/ });
      await appUser.screenshot();
      await appUser.click({ role: "button", label: `Searched your connections for “${request.query}”. Hide technical details` });
      const calls = await world.den.mocks.connector.agentRequests({ promptMarker: request.prompt });
      expect(calls.filter(call => call.kind === "tool")).toHaveLength(1);
      expect(calls.filter(call => call.kind === "tool").every(call => call.toolName?.endsWith("search_capabilities"))).toBe(true);
      expect(await probe.toolCalls(world.den.mocks.connector)).toEqual([]);
      expect((await world.den.mocks.connector.requests()).filter(entry => entry.path === "/authorize" || entry.path === "/token")).toEqual([]);
      expect((await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable")).body).toEqual(beforeRequests.body);
      evidence.recordAssertionEvidence("Setup discovery uses an ordinary tool line without connecting or opening a catalog", `${request.query} returned legacy connector metadata and setup URLs in technical details without modern catalog UI; one search, no provider calls, no OAuth, and no connection mutation.`, true);
    });
  }

  await step("the connector page's Chat link seeds a draft without sending or connecting", async () => {
    const webProbe = probe.on(world.web);
    const before = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    expect(before.response.ok).toBe(true);
    const modelRequests = await world.den.mocks.connector.agentRequests();
    const authRequests = (await world.den.mocks.connector.requests()).filter((entry) => entry.path === "/authorize" || entry.path === "/token");
    await webUser.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections/${encodeURIComponent(world.connection.id)}`);
    await webUser.see({ testId: "admin-connector-page" }, { timeoutMs: 90_000 });
    const heading = (await webProbe.dom('[data-testid="admin-connector-page"] h1')).elements[0]?.text ?? "";
    const chatLink = (await webProbe.connectorCatalog()).chatLinks[0];
    if (!chatLink) throw new Error("The connector page has no Chat link.");
    const link = new URL(chatLink.href);
    expect(`${link.protocol}//${link.host}`).toBe("openwork://chat");
    expect(link.searchParams.get("connector")).toBe(heading);
    expect([...link.searchParams.keys()].sort()).toEqual(["connector", "prompt"]);
    const prompt = link.searchParams.get("prompt");
    if (!prompt) throw new Error("Chat link has no starter prompt.");
    expect(prompt).not.toContain(world.connection.id);
    // Bridge only OS delivery. The real desktop listener must parse the rendered link and seed its own composer.
    await seed.deepLink(world.app, chatLink.href);
    await appUser.see("composer", { editable: true, text: new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    const composer = await appProbe.composer();
    expect(composer.draftText).toContain(heading);
    expect(composer.draftText).toContain(prompt);
    expect(composer.userMessageCount).toBe(0);
    expect(composer.assistantMessageCount).toBe(0);
    await appUser.notSee({ testId: "desktop-connection-card" });
    await appUser.notSee({ testId: "connector-catalog" });
    expect((await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable")).body).toEqual(before.body);
    expect(await world.den.mocks.connector.agentRequests()).toEqual(modelRequests);
    expect((await world.den.mocks.connector.requests()).filter((entry) => entry.path === "/authorize" || entry.path === "/token")).toEqual(authRequests);
    expect(await probe.toolCalls(world.den.mocks.connector)).toEqual([]);
    evidence.recordAssertionEvidence("Chat on the connector page seeds a draft only", `The ${heading} page's Chat link reached the desktop composer as a draft; no message sent, no OAuth, no connection change.`, true);
    await appUser.screenshot();
  });
});
