import { expect } from "vitest";
import { compileVerification, createJevVerificationEvaluator, runVerification, spec, type VerificationEvaluator, type VerificationPlan } from "@openwork/testkit";
import { memberRoutingWeb } from "../worlds/gateway-routing.ts";
import { normalizeRouterEditorValues, normalizeSavedRouterSnapshot, offlineRoutingEvaluator, routingAnswerMetadata, routingCheckIds, routingDictionary, routingIntent, unsupportedRoutingIntent } from "../worlds/gateway-routing-verification.ts";

const liveJev = process.env.OPENWORK_EVAL_JEV_ROUTING_VERIFY === "1";
const test = spec.world(memberRoutingWeb, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 600_000,
  needs: liveJev ? { env: ["JEV_AI_GATEWAY_API_KEY"] } : {},
});

test("a member creates, edits and reloads a prompt router in Den", async ({ world, user, probe, step, evidence }) => {
  await step("create a router using accessible model choices", async () => {
    await user.see({ role: "heading", text: "Model routing" }, { timeoutMs: 90_000 });
    await user.see({ text: "No routers yet. Create a router to match prompt categories to models." }, { timeoutMs: 60_000 });
    await user.notSee({ role: "link", label: "Gateway" });
    await user.screenshot();
    await user.click({ role: "button", label: "Create router" });
    await user.type({ label: "Name" }, "Daily work", { replace: true });
    await user.type({ label: "Prompt category 1" }, "Code review and debugging", { replace: true });
    await user.type({ label: "Prompt category 2" }, "Writing and editing", { replace: true });
    await user.click({ role: "button", label: "Model 1" });
    await user.click({ role: "option", label: world.modelLabels[0] });
    await user.click({ role: "button", label: "Model 2" });
    await user.click({ role: "option", label: world.modelLabels[1] });
    await user.see({ text: "I agree to send the latest user text to Jev to choose a model." });
    expect(await world.savedRouters()).toHaveLength(0);
    await user.click({ role: "switch", label: "Acknowledge prompt sharing with Jev" });
    await user.click({ role: "button", label: "Save router" });
    await user.see({ text: "Saved" }, { timeoutMs: 30_000 });
    expect(await world.savedRouters()).toMatchObject([{ name: "Daily work", revision: 1 }]);
    await user.screenshot();
  });
  await step("edit and reload persisted settings without running inference", async () => {
    await user.type({ label: "Name" }, "Daily work revised", { replace: true });
    await user.type({ label: "Prompt category 2" }, "Clear business writing", { replace: true });
    await user.click({ text: "Advanced" });
    await user.type({ label: "Minimum confidence" }, "0.75", { replace: true });
    await user.click({ role: "button", label: "Save router" });
    await user.see({ text: "Saved" }, { timeoutMs: 30_000 });
    await user.reload();
    await user.see({ role: "button", label: "Edit Daily work revised" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Edit Daily work revised" });
    await user.see({ label: "Name" }, { editable: true, timeoutMs: 30_000 });
    await user.click({ text: "Advanced" });
    const displayedValues = await probe.eval(() => Array.from(document.querySelectorAll<HTMLInputElement>('form[aria-label="Router editor"] input')).map(input => input.value));
    expect(displayedValues).toEqual(["Daily work revised", "Code review and debugging", "Clear business writing", "0.75"]);
    expect(await world.savedRouters()).toMatchObject([{ name: "Daily work revised", revision: 2, minConfidence: 0.75,
      routes: [{ description: "Code review and debugging" }, { description: "Clear business writing" }] }]);
    await user.notSee({ role: "button", label: /^Edit Daily work$/ });
    await user.screenshot();
    await user.click({ text: "Use this router" });
    await user.see({ text: /POST \/api\/v1\/routers\// });
    await user.see({ text: "Saved configuration only. No live request has been tested here." });
    await user.notSee({ role: "link", label: "Gateway" });
    const mode = liveJev ? "live Jev" : "deterministic offline selection fixture (not live Jev)";
    let evaluatorCalls = 0;
    const evaluator = liveJev ? createJevVerificationEvaluator({ onMetrics: metrics => {
      evidence.recordJsonArtifact("Jev routing selection model metrics", metrics);
    } }) : offlineRoutingEvaluator;
    const evaluate: VerificationEvaluator = async request => {
      evaluatorCalls++;
      const response = await evaluator(request);
      evidence.recordJsonArtifact(`Routing selection model metadata ${evaluatorCalls}: ${mode}`, {
        state: request.state, ...routingAnswerMetadata(response),
      });
      return response;
    };
    const compiled = await compileVerification({ intent: routingIntent, dictionary: routingDictionary, evaluate });
    evidence.recordAssertionEvidence(`Router verification compilation: ${mode}`, JSON.stringify(compiled), compiled.status === "ready");
    if (compiled.status !== "ready") throw new Error(`${mode} routing verification incomplete: ${compiled.reason}`);
    expect(compiled.plan.checkIds).toEqual(routingCheckIds);
    // Runtime validation at replay protects this JSON persistence boundary.
    const plan: VerificationPlan = JSON.parse(JSON.stringify(compiled.plan));
    const callsAfterCompile = evaluatorCalls;
    for (let replay = 0; replay < 2; replay++) {
      const result = await runVerification({ plan, dictionary: routingDictionary, channels: { user, probe, step }, observations: {
        "router-editor-values": { version: "1", read: async () => normalizeRouterEditorValues(await probe.eval(() => Array.from(document.querySelectorAll<HTMLInputElement>('form[aria-label="Router editor"] input')).map(input => input.value))) },
        "saved-router-snapshot": { version: "1", read: async () => normalizeSavedRouterSnapshot(await world.savedRouters()) },
      } });
      evidence.recordAssertionEvidence(`Router verification replay ${replay + 1}: ${mode}`, JSON.stringify(result), result.status === "passed");
      expect(result).toMatchObject({ status: "passed", checkIds: routingCheckIds, modelCalls: 0 });
      expect(evaluatorCalls).toBe(callsAfterCompile);
    }
    const unsupported = await compileVerification({ intent: unsupportedRoutingIntent, dictionary: routingDictionary, evaluate });
    evidence.recordAssertionEvidence(`Unsupported routing intent abstains: ${mode}`, JSON.stringify(unsupported), unsupported.status === "incomplete");
    expect(unsupported).toMatchObject({ status: "incomplete", reason: "Verification selection is unsupported or uncertain", modelCalls: 1 });
    await user.screenshot();
    evidence.recordAssertionEvidence("Member browser authoring persists across reload", "Created and revised through browser controls against real Den; reload retained revision 2 and category edits, provider management stayed absent, no live verification claimed.", true);
  });
  await step("revoked models remain visible and the owner can disable the router", async () => {
    await world.revokeModelAccess();
    await user.reload();
    await user.see({ text: "No accessible OpenAI-compatible models. Ask your workspace administrator to grant model access." });
    await user.see({ text: "Model unavailable" });
    await user.screenshot();
    await user.click({ role: "button", label: "Edit Daily work revised" });
    await user.see({ label: "Name" }, { editable: true });
    await user.click({ role: "switch", label: "Router active" });
    await user.click({ role: "button", label: "Save router" });
    await user.see({ text: "Saved" }, { timeoutMs: 30_000 });
    expect(await world.savedRouters()).toMatchObject([{ status: "disabled", revision: 3 }]);
    await user.screenshot();
    evidence.recordAssertionEvidence("Unavailable targets do not prevent disabling", "Revoked grants remain visible as unavailable; the original member disabled the same router through browser controls without substituting a model.", true);
  });
});
