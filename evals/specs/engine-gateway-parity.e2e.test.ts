import { expect } from "vitest";
import { resolveEvalEngine, spec } from "@openwork/testkit";
import { engineGatewayParity, parityRecord } from "../worlds/engine-gateway-parity.ts";

const test = spec.world(engineGatewayParity, {
  timeout: 600_000, resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});

test(`PARITY-GATEWAY ${resolveEvalEngine()}: use an assigned model, then see and use newly published models`, async ({ world, user, probe, step, evidence }) => {
  const document = await world.documentIdentity();
  const runtime = await world.runtime();
  await user.see("composer", { editable: true });
  let route = "";
  const providerId = await step("An administrator publishes a Gateway provider while this conversation is open", () => world.publish());
  let turn = 0;
  async function useModel(upstreamModelId: string) {
    if (world.engine === "v1") await step("Apply the legacy v1 engine reload and refresh the app", () => world.refreshLegacyCatalog());
    const inventory = await world.inventory();
    evidence.recordJsonArtifact(`Gateway routing for turn ${turn + 1}`, await world.routing());
    const model = inventory.find((model) => model.upstreamModelId === upstreamModelId);
    if (!model) throw new Error(`Missing assigned model ${upstreamModelId}`);
    await probe.eventually(() => world.readModels(), {
      within: 60_000, label: `${model.name} arrives in the app model picker`,
      until: (models) => models.some((candidate) => candidate.id === model.id),
    }).catch(async (error: unknown) => {
      evidence.recordJsonArtifact("Gateway discovery failure", { status: await world.request("/cloud-provider-sync/status"), runtime: await world.runtime(), inventory, native: await world.nativeModelIds(), events: world.nativeEvents(), screen: await probe.text() });
      await user.screenshot();
      throw error;
    });
    await user.screenshot();
    await world.selectModel(model.id);
    const prompt = `Give me a short answer using the selected model. Gateway request ${++turn}.`;
    const reply = `Gateway answer ${turn} arrived through the real proxy.`;
    await world.prepareTurn(prompt, reply);
    await user.type("composer", prompt, { verify: true });
    await probe.eventually(() => probe.composer(), {
      within: 30_000, label: "the selected model and draft are ready to send",
      until: (composer) => composer.runTaskEnabled && composer.draftText === prompt,
    });
    await user.click("Run task");
    await user.see({ text: reply }, { timeoutMs: 30_000 }).catch(async (error: unknown) => {
      evidence.recordJsonArtifact("Gateway answer failure", { screen: await probe.text(), calls: await world.mock.agentRequests(), runtime: await world.runtime(), errors: await world.serverErrors() });
      await user.screenshot();
      throw error;
    });
    await user.see("Run task");
    const calls = await world.mock.agentRequests({ promptMarker: prompt });
    expect(calls.filter((call) => call.kind === "final")).toHaveLength(1);
    expect(calls.every((call) => call.model === upstreamModelId)).toBe(true);
    if (route) expect(await world.route()).toBe(route);
    route = await world.route();
    if (world.engine === "v2") expect(await world.documentIdentity()).toBe(document);
    if (world.engine === "v2") expect((await world.runtime()).pid).toBe(runtime.pid);
    await probe.eventually(async () => parityRecord((await world.request("/cloud-provider-sync/status")).body).reloadPending, {
      within: 20_000, label: "provider synchronization settles after the answer", until: (pending) => pending === false,
    });
    await user.screenshot();
  }
  await step("Choose the assigned model and receive its answer through Gateway", () => useModel(world.models[0]));
  await step("Publish a second model and use it in the same conversation", async () => {
    await world.updateModels(world.models);
    await useModel(world.models[1]);
  });
  await step("Remove the first model and stop offering it in the picker", async () => {
    const removed = (await world.inventory()).find((model) => model.upstreamModelId === world.models[0]);
    if (!removed) throw new Error("Missing model before removal");
    await world.updateModels([world.models[1]]);
    if (world.engine === "v1") await step("Apply the legacy v1 reload after removing a model", () => world.refreshLegacyCatalog());
    await probe.eventually(() => world.readModels(), { within: 60_000, label: "removed model disappears", until: (models) => !models.some((model) => model.id === removed.id) });
    await useModel(world.models[1]);
  });
  evidence.recordJsonArtifact("Native catalog update events", world.nativeEvents());
  evidence.recordAssertionEvidence("Real Gateway model lifecycle", `Provider ${providerId} was created and updated through Den. Three user turns reached the real Gateway and then the synthetic upstream with the selected upstream model. V1 used its explicit legacy engine reload and app refresh; v2 kept the same document and PID with zero reloads.`, true);
  evidence.recordJsonArtifact("Engine reload requests during Gateway changes", { engine: world.engine, requests: await world.reloadRequests() });
  if (world.engine === "v2") expect(await world.reloadRequests()).toEqual([]);
});
