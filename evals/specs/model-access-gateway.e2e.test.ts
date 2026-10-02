import { expect } from "vitest";
import { resolveEvalEngine, spec } from "@openwork/testkit";
import { engineGatewayModelAccess } from "../worlds/engine-gateway-parity.ts";

const test = spec.world(engineGatewayModelAccess, {
  timeout: 600_000, resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});

test(`MODEL-ACCESS-GATEWAY ${resolveEvalEngine()}: with "Only models you provide", a member still uses the organization's Gateway model`, async ({ world, user, probe, step, evidence }) => {
  await user.see("composer", { editable: true });
  const providerId = await step("An administrator publishes a Gateway provider for an organization whose model access is \"Only models you provide\"", () => world.publish());
  if (world.engine === "v1") await step("Apply the legacy v1 engine reload and refresh the app", () => world.refreshLegacyCatalog());
  const model = (await world.inventory()).find((entry) => entry.upstreamModelId === world.models[0]);
  if (!model) throw new Error(`Missing assigned model ${world.models[0]}`);
  await probe.eventually(() => world.readModels(), {
    within: 60_000, label: `${model.name} is offered in the model picker`,
    until: (models) => models.some((candidate) => candidate.id === model.id),
  });
  if (world.engine === "v1") {
    const config = await world.engineConfig();
    evidence.recordJsonArtifact("Engine provider allow-list", { enabled_providers: config.enabled_providers });
    expect(config.enabled_providers).toContain(providerId);
  }
  await world.selectModel(model.id);
  const prompt = "Give me a short answer using the organization's Gateway model.";
  const reply = "Managed Gateway answer arrived through the real proxy.";
  await world.prepareTurn(prompt, reply);
  await user.type("composer", prompt, { verify: true });
  await probe.eventually(() => probe.composer(), {
    within: 30_000, label: "the Gateway model and draft are ready to send",
    until: (composer) => composer.runTaskEnabled && composer.draftText === prompt,
  });
  await user.click("Run task");
  await user.see({ text: reply }, { timeoutMs: 30_000 }).catch(async (error: unknown) => {
    evidence.recordJsonArtifact("Gateway answer failure", { screen: await probe.text(), calls: await world.mock.agentRequests(), errors: await world.serverErrors() });
    await user.screenshot();
    throw error;
  });
  const calls = await world.mock.agentRequests({ promptMarker: prompt });
  expect(calls.filter((call) => call.kind === "final")).toHaveLength(1);
  expect(calls.every((call) => call.model === model.upstreamModelId)).toBe(true);
  evidence.recordAssertionEvidence("Gateway send under model access", `Provider ${providerId} stayed available under "Only models you provide", and the answer came back through the real Gateway.`, true);
  await user.screenshot();
});
