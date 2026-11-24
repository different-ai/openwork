import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { isRecord } from "../worlds/library.ts";
import { gatewayTrueFoundryModelsWorld } from "../worlds/gateway-truefoundry-models.ts";

const test = spec.world(gatewayTrueFoundryModelsWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den", "mock"] } });
const WITHIN = 60_000;
const MODEL = "openai-main/gpt-5.5";

function efforts(config: Record<string, unknown> | null): string[] {
  const options = Array.isArray(config?.reasoning_options) ? config.reasoning_options.filter(isRecord) : [];
  return options.flatMap((option) => option.type === "effort" && Array.isArray(option.values) ? option.values.map(String) : []);
}

function trackUsageCosts(body: unknown): unknown {
  const provider = isRecord(body) && isRecord(body.inferenceProvider) ? body.inferenceProvider : null;
  return provider && isRecord(provider.truefoundry) ? provider.truefoundry.trackUsageCosts : "missing";
}

test("TrueFoundry models carry their reasoning efforts, and an admin can track their usage costs in OpenWork", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });

  await step("a matched model reaches the member with its reasoning efforts and without a price", async () => {
    const config = await world.memberModelConfig(MODEL);
    const levels = efforts(config);
    const ok = levels.includes("high") && config?.cost === undefined;
    evidence.recordAssertionEvidence("GPT-5.5 has effort levels (the app's reasoning menu) and no price", `efforts=${JSON.stringify(levels)}; cost=${JSON.stringify(config?.cost ?? null)}`, ok);
    expect(levels).toContain("high");
    expect(config?.cost).toBeUndefined();
  });

  await step("the provider page shows Track usage costs in OpenWork below Create missing users, off", async () => {
    await user.see({ testId: "truefoundry-track-usage-costs" }, { timeoutMs: WITHIN });
    await user.see({ text: "Track usage costs in OpenWork" });
    await user.see({ text: /This will use the models default public pricing/ });
    await user.see({ text: "Not tracked, TrueFoundry budgets each person" });
    const missing = (await probe.dom('[data-testid="truefoundry-create-missing-users"]')).elements[0]?.rect.top ?? Number.NaN;
    const costs = (await probe.dom('[data-testid="truefoundry-track-usage-costs"]')).elements[0]?.rect.top ?? Number.NaN;
    evidence.recordAssertionEvidence("The toggle sits below Create missing users", `missing users top=${missing}; usage costs top=${costs}`, costs > missing);
    expect(costs).toBeGreaterThan(missing);
    expect(trackUsageCosts((await world.provider()).body)).toBe(false);
    await user.screenshot();
  });

  await step("turning it on serves the model's public price to the member", async () => {
    await user.click({ testId: "truefoundry-track-usage-costs" });
    await user.see({ text: /OpenWork now tracks usage costs for TrueFoundry models with public pricing/ }, { timeoutMs: WITHIN });
    await user.see({ text: "Tracked in OpenWork at public pricing, where a model has it" });
    const config = await probe.eventually(() => world.memberModelConfig(MODEL), { within: WITHIN, label: "the member's model is priced", until: (value) => isRecord(value?.cost) });
    const cost = isRecord(config?.cost) ? config.cost : null;
    const ok = typeof cost?.input === "number" && typeof cost.output === "number" && trackUsageCosts((await world.provider()).body) === true;
    evidence.recordAssertionEvidence("The setting is saved and GPT-5.5 is served with its public price", `cost=${JSON.stringify(cost)}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("turning it off removes the price again", async () => {
    await user.click({ testId: "truefoundry-track-usage-costs" });
    await user.see({ text: /OpenWork no longer tracks TrueFoundry usage costs/ }, { timeoutMs: WITHIN });
    const config = await probe.eventually(() => world.memberModelConfig(MODEL), { within: WITHIN, label: "the member's model is unpriced", until: (value) => value !== null && value.cost === undefined });
    const ok = config?.cost === undefined && efforts(config).includes("high");
    evidence.recordAssertionEvidence("No price, efforts kept", `efforts=${JSON.stringify(efforts(config))}; cost=${JSON.stringify(config?.cost ?? null)}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });
});
