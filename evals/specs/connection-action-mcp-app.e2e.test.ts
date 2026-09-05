import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { connectionActionMcpApp, connectionActionPrompt, connectionActionReply } from "../worlds/library.ts";

const test = spec.world(connectionActionMcpApp, { timeout: 600_000 });

test("desktop connects an account directly with the provider and confirms authorization in chat", async ({ world, agent, user, probe, evidence }) => {
  expect(connectionActionPrompt).not.toContain(world.connection.id);
  await agent.send(connectionActionPrompt);
  await user.see({ text: connectionActionReply }, { timeoutMs: 120_000 });
  await user.see({ testId: "desktop-connection-card" });
  await user.see({ role: "button", label: "Connect Notes" });
  await user.notSee({ text: "Connected" });
  const calls = await world.den.mocks.connector.agentRequests({ promptMarker: connectionActionPrompt });
  expect(calls.filter(call => call.kind === "tool").every(call => call.toolName?.endsWith("search_capabilities"))).toBe(true);
  expect(calls.filter(call => call.kind === "tool")).toHaveLength(1);
  expect((await world.den.mocks.connector.requests()).filter(request => request.path === "/authorize")).toHaveLength(0);
  const compact = await probe.eval(`(() => {
    const card = document.querySelector('[data-testid="desktop-connection-card"]');
    return { height: card?.getBoundingClientRect().height, hasChecklist: Boolean(card?.querySelector('ol')), embeddedApp: Boolean(document.querySelector('[data-mcp-app-resource="ui://openwork/connection-action/v1/view.html"]')) };
  })()`);
  expect(compact).toMatchObject({ hasChecklist: false, embeddedApp: false });
  if (!compact || typeof compact !== "object" || !("height" in compact) || typeof compact.height !== "number") throw new Error("The connection card was not rendered.");
  expect(compact.height).toBeLessThan(130);
  await user.screenshot();
  evidence.recordAssertionEvidence("Search shows one native connection card without a checklist or embedded setup", JSON.stringify(compact), true);
  evidence.recordAssertionEvidence("Authorization does not start before the user clicks Connect", "No provider authorization request before Connect", true);

  const clickedAt = new Date().toISOString();
  await user.click({ role: "button", label: "Connect Notes" });
  const authorization = await world.den.mocks.connector.authorizeRequestSince(clickedAt, { timeoutMs: 60_000 });
  expect(authorization.path).toBe("/authorize");
  expect(authorization.params.get("state")).toBeTruthy();
  await user.see({ text: "Connected" }, { timeoutMs: 120_000 });
  await user.notSee({ role: "button", label: "Connect Notes" });
  await user.notSee({ text: "Your Connections" });
  await user.screenshot();
  evidence.recordAssertionEvidence("Desktop opens the provider directly and confirms completion without a Den screen", "Provider /authorize received the browser handoff; the native card shows Connected and removes Connect", true);
});
