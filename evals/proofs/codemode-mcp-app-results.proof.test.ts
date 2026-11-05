import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { codemodeMcpAppResults } from "../worlds/codemode-mcp-app-results.ts";

const test = spec.world(codemodeMcpAppResults, {
  timeout: 600_000, resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

test("a member opens an external recipient form from one script and can use it again after reloading without sending anything", async ({ world, user, probe, step, evidence }) => {
  const inside = { resourceUri: world.resourceUri };

  await step("before: the member has not opened a recipient review or sent anything", async () => {
    await user.see("composer");
    const runtime = await probe.desktopApi("/experimental/engine-v2-preview/status");
    expect(runtime.status).toBe(200);
    expect(runtime.body).toMatchObject({ chatRouting: true, pid: expect.any(Number) });
    expect(world.prompt).not.toMatch(/mcp:|ui:\/\/|execute_capability|connectionId/);
    const calls = await world.connector.toolCalls();
    const frames = await probe.dom("[data-mcp-app-resource] > iframe");
    expect(calls).toHaveLength(0);
    expect(frames.elements).toHaveLength(0);
    evidence.recordAssertionEvidence("The real V2 engine is ready, with no recipient App or connector action yet", JSON.stringify({ runtime: runtime.body, connectorCalls: calls.length, appFrames: frames.elements.length }), calls.length === 0 && frames.elements.length === 0);
    await user.screenshot();
  });

  await step("the member asks for a recipient review and the connected service answers through one script", async () => {
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await user.see({ text: world.reply }, { timeoutMs: 120_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    const calls = await world.connector.toolCalls({ name: "review_recipient", atLeast: 1, timeoutMs: 30_000 });
    const requests = await world.model.agentRequests({ promptMarker: world.prompt, atLeast: 2, timeoutMs: 30_000 });
    const scripted = requests.filter(request => request.kind === "tool");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual({});
    expect(scripted).toHaveLength(1);
    expect(scripted[0]).toMatchObject({ toolName: "execute", arguments: { code: world.code } });
    evidence.recordAssertionEvidence("One Code Mode script reached the real capability gateway and the local connector once", JSON.stringify({ tools: scripted.map(request => request.toolName), connectorCalls: calls.map(call => ({ name: call.name, args: call.args })), outerReturn: "Recipient review opened" }), scripted.length === 1 && scripted[0]?.toolName === "execute" && calls.length === 1);
    await user.screenshot();
  });

  await step("after: the App receives the full result and the member can open its recipient review", async () => {
    // This form is hidden until ui/notifications/tool-result contains content,
    // structuredContent and the provider's per-run metadata receipt. A launch
    // tile, assistant text or empty iframe cannot satisfy these checks.
    await user.see({ role: "heading", label: "Recipient required", mcpApp: inside }, { timeoutMs: 90_000 });
    await user.click({ role: "button", label: "Review recipient", mcpApp: inside });
    await user.see({ role: "heading", label: "Recipient review opened locally. Draft remains unsent.", mcpApp: inside });
    const calls = await world.connector.toolCalls();
    expect(calls.map(call => call.name)).toEqual(["review_recipient"]);
    evidence.recordAssertionEvidence("The recipient App's real button works without a send or another connector action", JSON.stringify({ status: "Recipient review opened locally. Draft remains unsent.", connectorCalls: calls.map(call => call.name) }), calls.length === 1 && calls[0]?.name === "review_recipient");
    await user.screenshot();
  });

  await step("after: reloading restores the saved recipient request without rerunning the service or sending a message", async () => {
    const requestsBefore = await world.model.agentRequests({ promptMarker: world.prompt });
    await user.reload();
    await user.see({ text: world.reply }, { timeoutMs: 60_000 });
    await user.see({ role: "heading", label: "Recipient required", mcpApp: inside }, { timeoutMs: 90_000 });
    await user.see({ role: "button", label: "Review recipient", mcpApp: inside });
    await user.see({ role: "heading", label: "Nothing has been sent.", mcpApp: inside });
    const calls = await world.connector.toolCalls();
    const requestsAfter = await world.model.agentRequests({ promptMarker: world.prompt });
    expect(calls.map(call => call.name)).toEqual(["review_recipient"]);
    expect(requestsAfter).toHaveLength(requestsBefore.length);
    evidence.recordAssertionEvidence("The saved full result restores the form after reload with zero new model or connector calls", JSON.stringify({ state: "ask_email", sent: false, connectorCalls: calls.length, modelRequestsBefore: requestsBefore.length, modelRequestsAfter: requestsAfter.length }), calls.length === 1 && requestsAfter.length === requestsBefore.length);
    await user.screenshot();
  });
});
