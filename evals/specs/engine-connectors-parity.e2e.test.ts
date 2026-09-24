import { expect } from "vitest";
import { resolveEvalEngine, spec } from "@openwork/testkit";
import { engineConnectorsParity } from "../worlds/engine-connectors-parity.ts";

const test = spec.world(engineConnectorsParity, {
  timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});

test(`PARITY-CONNECTORS ${resolveEvalEngine()}: search assigned capabilities, execute a connector and show its result`, async ({ world, user, probe, step, evidence }) => {
  const document = await world.documentIdentity();
  const runtime = await world.runtime();
  await step("Ask for a report without knowing its capability ID or result", async () => {
    const prompt = "Read the latest amber report using my connections.";
    await world.prepareReport(prompt);
    expect(prompt).not.toContain(world.proof);
    await user.type("composer", prompt);
    await user.click("Run task");
    await user.see({ text: world.proof }, { timeoutMs: 90_000 });
    await user.see("Run task");
    const calls = await world.den.mocks.report.toolCalls();
    expect(calls).toMatchObject([{ name: "current_amber_report", args: {} }]);
    const requests = await world.mock.agentRequests({ promptMarker: prompt });
    expect(requests.some((request) => request.kind === "error")).toBe(false);
    if (world.engine === "v1") expect(requests.filter((request) => request.kind === "tool").map((request) => request.toolName))
      .toEqual([expect.stringMatching(/search_capabilities$/), expect.stringMatching(/execute_capability$/)]);
    await user.screenshot();
  });
  const route = await world.route();
  await step("A connector failure is returned truthfully in the same conversation", async () => {
    const prompt = "Read the unavailable amber report using my connections.";
    await world.prepareReport(prompt, true);
    await user.type("composer", prompt);
    await user.click("Run task");
    await user.see({ text: /requested provider operation failed/ }, { timeoutMs: 90_000 });
    await user.see("Run task");
    expect((await world.den.mocks.report.toolCalls()).map((call) => call.name)).toEqual(["current_amber_report", "unavailable_violet_status"]);
    expect(await world.route()).toBe(route);
    expect(await world.documentIdentity()).toBe(document);
    if (world.engine === "v2") expect((await world.runtime()).pid).toBe(runtime.pid);
    await user.screenshot();
  });
  evidence.recordAssertionEvidence("Real capability discovery and execution", "The model used Den search_capabilities to obtain the current capability ID and execute_capability to invoke an independently witnessed connector. The random result existed only at the connector; an error result was also returned. The external service and model are synthetic; Den, app and engine are real.", true);
});
