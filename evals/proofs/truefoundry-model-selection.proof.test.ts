import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { isRecord } from "../worlds/library.ts";
import { TRUEFOUNDRY_CHAT_MODELS, TRUEFOUNDRY_EMBEDDING_MODEL, gatewayTrueFoundryModelsWorld } from "../worlds/gateway-truefoundry-models.ts";

const test = spec.world(gatewayTrueFoundryModelsWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den", "mock"] } });
const WITHIN = 60_000;
const ALL = [...TRUEFOUNDRY_CHAT_MODELS].sort();
const PICKED = ["anthropic-main/claude-sonnet-4-5", "openai-main/gpt-4o-mini"];

function status(body: unknown) {
  const provider = isRecord(body) && isRecord(body.inferenceProvider) ? body.inferenceProvider : null;
  const truefoundry = provider && isRecord(provider.truefoundry) ? provider.truefoundry : null;
  return {
    modelCount: typeof truefoundry?.modelCount === "number" ? truefoundry.modelCount : -1,
    selectedModelIds: Array.isArray(truefoundry?.selectedModelIds) ? truefoundry.selectedModelIds.map(String).sort() : truefoundry?.selectedModelIds === null ? null : "missing",
  };
}

test("an admin picks which TrueFoundry models people get, like any other provider", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });

  await step("the TrueFoundry provider page has a Models card set to every TrueFoundry chat model", async () => {
    await user.see({ testId: "truefoundry-models" }, { timeoutMs: WITHIN });
    await user.see({ text: "All TrueFoundry models" });
    await user.see({ text: "Only the ones I pick" });
    const members = await world.memberModels();
    evidence.recordAssertionEvidence("The member starts with every TrueFoundry chat model", JSON.stringify(members), JSON.stringify(members) === JSON.stringify(ALL));
    expect(members).toEqual(ALL);
    await user.screenshot();
  });

  await step("Only the ones I pick lists the chat models TrueFoundry serves, never the embedding model", async () => {
    await user.click({ testId: "gateway-models-pick" });
    await user.see({ testId: "gateway-models-count" });
    const rows = (await probe.dom('[data-testid="truefoundry-models"] input[type="checkbox"]')).elements.length;
    const embedding = (await probe.dom(`[data-testid="gateway-model-${TRUEFOUNDRY_EMBEDDING_MODEL}"]`)).elements.length;
    evidence.recordAssertionEvidence("One row per chat model and none for the embedding model", `rows=${rows}; embedding rows=${embedding}`, rows === ALL.length && embedding === 0);
    expect(rows).toBe(ALL.length);
    expect(embedding).toBe(0);
    await user.screenshot();
  });

  await step("the filter narrows the list", async () => {
    await user.type({ label: "Filter models" }, "sonnet");
    await probe.eventually(() => probe.dom('[data-testid="truefoundry-models"] input[type="checkbox"]'), { within: WITHIN, label: "one model matches", until: (dom) => dom.elements.length === 1 });
    await user.screenshot();
    await user.click({ label: "Filter models" });
    await user.press("Meta+A");
    await user.press("Backspace");
    await probe.eventually(() => probe.dom('[data-testid="truefoundry-models"] input[type="checkbox"]'), { within: WITHIN, label: "every model is listed again", until: (dom) => dom.elements.length === ALL.length });
  });

  await step("saving two picked models serves only those to the member", async () => {
    await user.click({ testId: "gateway-models-clear" });
    for (const id of PICKED) await user.click({ testId: `gateway-model-${id}` });
    await user.see({ text: `${PICKED.length} of ${ALL.length} selected` });
    await user.click({ testId: "truefoundry-save-models" });
    await user.see({ text: /People now get only the 2 models you picked/ }, { timeoutMs: WITHIN });
    const saved = status((await world.provider()).body);
    const members = await probe.eventually(() => world.memberModels(), { within: WITHIN, label: "the member's models follow the pick", until: (ids) => ids.length === PICKED.length });
    const ok = saved.modelCount === PICKED.length && JSON.stringify(saved.selectedModelIds) === JSON.stringify(PICKED) && JSON.stringify(members) === JSON.stringify(PICKED);
    evidence.recordAssertionEvidence("The pick is saved and the member gets exactly the picked models", `saved=${JSON.stringify(saved)}; member=${JSON.stringify(members)}`, ok);
    expect(saved).toEqual({ modelCount: PICKED.length, selectedModelIds: PICKED });
    expect(members).toEqual(PICKED);
    await user.screenshot();
  });

  await step("the pick survives a sync", async () => {
    await user.click({ testId: "truefoundry-sync" });
    await user.see({ text: /^Synced 2 models/ }, { timeoutMs: WITHIN });
    const members = await world.memberModels();
    evidence.recordAssertionEvidence("A sync keeps the pick", JSON.stringify(members), JSON.stringify(members) === JSON.stringify(PICKED));
    expect(members).toEqual(PICKED);
  });

  await step("All TrueFoundry models gives the member every model again", async () => {
    await user.click({ testId: "gateway-models-all" });
    await user.click({ testId: "truefoundry-save-models" });
    await user.see({ text: /People now get every TrueFoundry model/ }, { timeoutMs: WITHIN });
    const members = await probe.eventually(() => world.memberModels(), { within: WITHIN, label: "the member gets every model", until: (ids) => ids.length === ALL.length });
    const saved = status((await world.provider()).body);
    evidence.recordAssertionEvidence("Back to every model", `saved=${JSON.stringify(saved)}; member=${JSON.stringify(members)}`, saved.selectedModelIds === null && members.length === ALL.length);
    expect(saved).toEqual({ modelCount: ALL.length, selectedModelIds: null });
    expect(members).toEqual(ALL);
    await user.screenshot();
  });
});

