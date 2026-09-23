import { expect } from "vitest";
import { browserScript, spec } from "@openwork/testkit";
import { customEndpointKey, customEndpointModels, gatewayCustomProvider } from "../worlds/gateway-custom-provider.ts";
import { usageRecord, usageRecords } from "../worlds/gateway-usage-policy.ts";

const test = spec.world(gatewayCustomProvider, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

test("an owner adds a custom OpenAI-compatible endpoint from the top of Add a provider and a member's request reaches it", async ({
  world, user, probe, step, evidence,
}) => {
  const owner = user.on(world.admin);
  const ownerProbe = probe.on(world.admin);
  const name = "Team model server";
  const saved = async () => usageRecords(usageRecord((await probe.api(world.den.admin, "/v1/inference-providers?scope=manageable")).body).inferenceProviders)
    .find((entry) => entry.name === name);

  await step("before: Custom provider is the first row of Add a provider, and filtering for it keeps it", async () => {
    await owner.see({ testId: "gateway-provider-pick-custom" }, { timeoutMs: 90_000 });
    await owner.see({ testId: "gateway-provider-pick-openrouter" }, { timeoutMs: 60_000 });
    const firstRow = await ownerProbe.eval(browserScript(() => document.querySelector("ul li a")?.getAttribute("data-testid") ?? null, []));
    evidence.recordAssertionEvidence("custom provider is the first row", `first row: ${String(firstRow)}`, firstRow === "gateway-provider-pick-custom");
    expect(firstRow).toBe("gateway-provider-pick-custom");
    await owner.type({ testId: "gateway-provider-catalog-filter" }, "custom");
    await owner.see({ testId: "gateway-provider-pick-custom" });
    await owner.notSee({ testId: "gateway-provider-pick-openrouter" });
    expect(await saved()).toBeUndefined();
    await owner.screenshot();
  });

  await step("clicking it opens a custom provider form, not another provider's page", async () => {
    await owner.click({ testId: "gateway-provider-pick-custom" });
    await owner.see({ testId: "gateway-provider-title" }, { text: "Add a custom provider", timeoutMs: 30_000 });
    await owner.see({ testId: "gateway-custom-endpoint" });
    await owner.see({ text: "Check the endpoint to list its models, or add a model ID." });
    await owner.screenshot();
  });

  await step("Check endpoint lists the models the endpoint serves, and an extra model ID can be added", async () => {
    await owner.type({ testId: "gateway-custom-name" }, name);
    await owner.type({ testId: "gateway-custom-endpoint" }, world.endpointUrl);
    await owner.type({ testId: "gateway-provider-api-key" }, customEndpointKey);
    await owner.click({ testId: "gateway-custom-check" });
    await owner.see({ testId: "gateway-custom-check-result" }, { text: /Found 2 models/, timeoutMs: 30_000 });
    for (const model of customEndpointModels) await owner.see({ testId: `gateway-model-${model}` });
    await owner.type({ testId: "gateway-custom-model-input" }, "team-llm-extra");
    await owner.click({ testId: "gateway-custom-model-add" });
    await owner.see({ testId: "gateway-model-team-llm-extra" });
    const checked = await ownerProbe.eval(browserScript(() => [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-testid^="gateway-model-"]')].filter((input) => input.checked).map((input) => input.dataset.testid), []));
    expect(checked).toEqual(["gateway-model-team-llm-a", "gateway-model-team-llm-b", "gateway-model-team-llm-extra"]);
    await owner.screenshot();
  });

  const providerId = await step("after: Add provider saves it with its endpoint and exactly those models", async () => {
    await owner.click({ testId: "gateway-provider-save" });
    await owner.see({ text: name }, { timeoutMs: 30_000 });
    await ownerProbe.eventually(() => ownerProbe.eval(browserScript(() => location.pathname, [])), {
      within: 30_000, intervalMs: 250, label: "back on AI Providers", until: (path) => path === "/dashboard/ai-gateway",
    });
    const provider = await probe.eventually(saved, { within: 15_000, intervalMs: 250, label: "custom provider persisted", until: (value) => value !== undefined });
    if (!provider) throw new Error("Custom provider was not saved");
    evidence.recordAssertionEvidence("saved as a custom provider", JSON.stringify({ providerId: provider.providerId, modelIds: provider.modelIds, settings: provider.settings }), provider.providerId === "openwork-custom");
    expect(provider).toMatchObject({ providerId: "openwork-custom", modelIds: ["team-llm-a", "team-llm-b", "team-llm-extra"], settings: { upstreamBaseUrl: world.endpointUrl } });
    expect(JSON.stringify(provider)).not.toContain(customEndpointKey);
    await owner.screenshot();
    return String(provider.id);
  });

  await step("a member's request through the Gateway reaches the custom endpoint with the organization's key", async () => {
    const connected = await world.connect(providerId);
    expect(connected.models.length).toBe(3);
    expect(new URL(connected.baseUrl).origin).toBe(world.gatewayUrl);
    const before = world.endpointChats().length;
    const result = await world.chat(connected.baseUrl, connected.apiKey, connected.models[0] ?? "");
    const chat = world.endpointChats().at(-1);
    evidence.recordAssertionEvidence("request proxied to the custom endpoint", JSON.stringify({ status: result.status, upstreamModel: chat?.model, upstreamCalls: world.endpointChats().length - before }), result.status === 200);
    expect(result.status).toBe(200);
    expect(world.endpointChats().length).toBe(before + 1);
    expect(customEndpointModels).toContain(chat?.model);
    expect(chat?.credential).toBe(`Bearer ${customEndpointKey}`);
    expect(JSON.stringify(result.body)).toContain("Custom endpoint answered");
  });
});
