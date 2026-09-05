import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { connectionActionMcpApp, connectionActionPrompt, connectionActionReply, ordinaryDiscoveryPrompt, ordinaryDiscoveryReply } from "../worlds/library.ts";

const test = spec.world(connectionActionMcpApp, { timeout: 600_000 });

test("desktop connects an account directly with the provider and confirms authorization in chat", async ({ world, agent, user, probe, evidence }) => {
  await agent.send(ordinaryDiscoveryPrompt);
  await user.see({ text: ordinaryDiscoveryReply }, { timeoutMs: 120_000 });
  await user.notSee({ testId: "desktop-connection-card" });
  await user.notSee({ testId: "connector-catalog" });
  await user.notSee({ role: "button", label: "Connect Notion" });
  expect((await world.den.mocks.connector.requests()).filter(request => request.path === "/authorize")).toHaveLength(0);
  const discoveryCalls = await world.den.mocks.connector.agentRequests({ promptMarker: ordinaryDiscoveryPrompt });
  expect(discoveryCalls.filter(call => call.kind === "tool")).toHaveLength(1);
  await user.screenshot();
  evidence.recordAssertionEvidence("Ordinary discovery of an unconnected service stays quiet", "Dashboard capability search completed without a connection card, catalog, Connect button, or provider authorization request", true);
  await user.click({ role: "button", label: "New session" });
  await user.see({ text: "Try one of these:" });
  expect(connectionActionPrompt).not.toContain(world.connection.id);
  await agent.send(connectionActionPrompt);
  await user.see({ text: connectionActionReply }, { timeoutMs: 120_000 });
  await user.see({ testId: "desktop-connection-card" });
  await user.see({ role: "button", label: "Connect Notion" });
  await user.notSee({ text: "Connected" });
  await user.notSee({ text: "Finish sign-in in your browser" });
  const calls = await world.den.mocks.connector.agentRequests({ promptMarker: connectionActionPrompt });
  expect(calls.filter(call => call.kind === "tool").every(call => call.toolName?.endsWith("search_capabilities"))).toBe(true);
  expect(calls.filter(call => call.kind === "tool")).toHaveLength(1);
  expect((await world.den.mocks.connector.requests()).filter(request => request.path === "/authorize")).toHaveLength(0);
  const compact = await probe.eval(`(() => {
    const card = document.querySelector('[data-testid="desktop-connection-card"]');
    return { height: card?.getBoundingClientRect().height, width: card?.getBoundingClientRect().width, hasChecklist: Boolean(card?.querySelector('ol')), embeddedApp: Boolean(document.querySelector('[data-mcp-app-resource="ui://openwork/connection-action/v1/view.html"]')) };
  })()`);
  expect(compact).toMatchObject({ hasChecklist: false, embeddedApp: false });
  if (!compact || typeof compact !== "object" || !("height" in compact) || typeof compact.height !== "number" || !("width" in compact) || typeof compact.width !== "number") throw new Error("The connection card was not rendered.");
  expect(compact.height).toBeLessThan(88);
  await user.screenshot();
  evidence.recordAssertionEvidence("Search shows one native connection card without a checklist or embedded setup", JSON.stringify(compact), true);
  evidence.recordAssertionEvidence("Authorization does not start before the user clicks Connect", "No provider authorization request before Connect", true);

  await probe.eval(`(() => {
    const card = document.querySelector('[data-testid="desktop-connection-card"]');
    if (!card) throw new Error("Connection card missing");
    const sizes = [];
    const record = () => { const rect = card.getBoundingClientRect(); sizes.push({ width: rect.width, height: rect.height, text: card.textContent }); card.dataset.observedSizes = JSON.stringify(sizes); };
    new MutationObserver(record).observe(card, { childList: true, subtree: true, characterData: true });
    record();
  })()`);
  const clickedAt = new Date().toISOString();
  await user.click({ role: "button", label: "Connect Notion" });
  const authorization = await world.den.mocks.connector.authorizeRequestSince(clickedAt, { timeoutMs: 60_000 });
  expect(authorization.path).toBe("/authorize");
  expect(authorization.params.get("state")).toBeTruthy();
  await user.see({ text: "Connected" }, { timeoutMs: 120_000 });
  await user.notSee({ role: "button", label: "Connect Notion" });
  await user.notSee({ text: "Your Connections" });
  const completed = await probe.eval(`(() => {
    const card = document.querySelector('[data-testid="desktop-connection-card"]');
    return { height: card?.getBoundingClientRect().height, width: card?.getBoundingClientRect().width, buttons: card?.querySelectorAll('button').length };
  })()`);
  expect(completed).toMatchObject({ buttons: 0 });
  if (!completed || typeof completed !== "object" || !("height" in completed) || typeof completed.height !== "number") throw new Error("The connected indicator was not rendered.");
  expect(completed.height).toBe(compact.height);
  expect(completed).toMatchObject({ width: compact.width });
  evidence.recordAssertionEvidence("Connection completion preserves the card dimensions", JSON.stringify({ ready: compact, connected: completed }), true);
  const transitions = await probe.eval(`JSON.parse(document.querySelector('[data-testid="desktop-connection-card"]')?.getAttribute("data-observed-sizes") ?? "[]")`);
  if (!Array.isArray(transitions)) throw new Error("No card transition measurements were recorded");
  for (const dimensions of transitions) expect(dimensions).toMatchObject({ width: compact.width, height: compact.height });
  for (const status of ["Opening sign-in…", "Finish sign-in in your browser", "Ready to use"]) {
    expect(transitions).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(status) })]));
  }
  evidence.recordAssertionEvidence("Sign-in transitions keep the card dimensions stable", JSON.stringify(transitions), true);
  await user.screenshot();
  evidence.recordAssertionEvidence("Desktop opens the provider directly and confirms completion without a Den screen", "Provider /authorize received the browser handoff; the native card shows Connected and removes Connect", true);
});
