import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { allConnectorsPrompt, allConnectorsReply, connectorCatalogDiscovery, connectorCatalogPrompt, connectorCatalogReply } from "../worlds/library.ts";

const test = spec.world(connectorCatalogDiscovery, { timeout: 600_000 });

test("chat suggests Slack setup and lets an admin browse every quick-add connector", async ({ world, agent, user, probe, evidence }) => {
  const appUser = user.on(world.app);
  const appProbe = probe.on(world.app);
  const webUser = user.on(world.web);
  expect(connectorCatalogPrompt).not.toContain(world.connection.id);
  await agent.on(world.app).send(connectorCatalogPrompt);
  await appUser.see({ text: connectorCatalogReply }, { timeoutMs: 120_000 });
  await appUser.see({ testId: "connector-catalog" });
  await appUser.see({ role: "button", label: "Set up Slack" });
  await appUser.see({ text: "Admin setup" });
  await appUser.notSee({ testId: "desktop-connection-card" });
  const visibleIds = () => appProbe.eval(`Array.from(document.querySelectorAll('[data-connector-preset]'), element => element.getAttribute('data-connector-preset'))`);
  expect(await visibleIds()).toEqual(["slack"]);
  await appUser.screenshot();
  evidence.recordAssertionEvidence("A Slack request offers setup without claiming the service is connected", "Only Slack is suggested with Admin setup; no account connection card is shown", true);

  await appUser.click({ role: "button", label: `Browse all ${world.expectedIds.length}` });
  await appUser.see({ role: "textbox", label: "Filter connectors" });
  expect(await visibleIds()).toEqual(world.expectedIds);
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
  await appUser.click({ role: "button", label: "Set up Slack" });
  await appUser.notSee({ role: "alert" });

  // Continue the external-browser handoff in the signed-in browser surface.
  const setupUrl = new URL("/dashboard/mcp-connections", world.den.ref.webUrl);
  setupUrl.searchParams.set("quickAdd", "slack");
  await webUser.navigate(setupUrl.toString());
  await webUser.see({ text: "OAuth app" }, { timeoutMs: 90_000 });
  await webUser.see({ text: "Client ID (optional for now)" });
  await webUser.see({ text: "Client secret (optional for now)" });
  await webUser.screenshot();
  const calls = await world.den.mocks.connector.agentRequests({ promptMarker: connectorCatalogPrompt });
  expect(calls.filter(call => call.kind === "tool")).toHaveLength(1);
  expect(calls.filter(call => call.kind === "tool").every(call => call.toolName?.endsWith("search_capabilities"))).toBe(true);
  expect((await world.den.mocks.connector.requests()).filter(request => request.path === "/authorize")).toHaveLength(0);
  await appUser.click({ role: "button", label: "New task" });
  await agent.on(world.app).send(allConnectorsPrompt);
  await appUser.see({ text: allConnectorsReply }, { timeoutMs: 120_000 });
  const listed = await appProbe.eval(`(() => {
    const cards = Array.from(document.querySelectorAll('[data-testid="connector-catalog"]'));
    return Array.from(cards.at(-1)?.querySelectorAll('[data-connector-preset]') ?? [], entry => entry.getAttribute('data-connector-preset'));
  })()`);
  expect(listed).toEqual(world.expectedIds);
  await appUser.screenshot();
  evidence.recordAssertionEvidence("Asking for all quick adds immediately opens the complete catalog", JSON.stringify(listed), true);
  evidence.recordAssertionEvidence("Filtering selects Slack and its setup destination opens the OAuth client form", "Slack quickAdd deep link renders client fields; the agent only searched and did not execute setup or authorize an account", true);
});
