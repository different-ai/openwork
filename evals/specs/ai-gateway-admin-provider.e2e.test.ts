import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { aiGatewayAdmin } from "../worlds/ai-gateway-admin.ts";

// AI Gateway is one form per provider — Key, Who can use it, Models —
// on top of the existing provider, credential set, model group and grants.
const test = spec.world(aiGatewayAdmin, {
  timeout: 420_000,
  resources: { surfaces: ["web"], services: ["den"] },
  needs: { commands: ["pnpm"], optIn: ["OPENWORK_EVAL_E2E_TESTS"] },
});

function grantsOf(provider: Record<string, unknown>) {
  return Array.isArray(provider.accessGrants) ? provider.accessGrants.map((grant) => JSON.stringify(grant)) : [];
}

test("an admin adds a provider for everyone in one form, then limits it to Marketing and one model", async ({ world, user, probe, step, evidence }) => {
  await step("before: a first visit to AI Gateway shows nothing set up and one way to start", async () => {
    await user.see({ testId: "gateway-empty" }, { timeoutMs: 90_000 });
    await user.see({ text: "No providers yet" });
    await user.screenshot();
  });

  await step("the admin picks OpenRouter from the provider list", async () => {
    await user.click({ testId: "gateway-provider-create" });
    await user.see({ testId: "gateway-provider-catalog" }, { timeoutMs: 30_000 });
    await user.type({ placeholder: "Filter by name…" }, "OpenRouter");
    await user.click({ testId: "gateway-catalog-provider" });
    await user.see({ text: "Add OpenRouter" }, { timeoutMs: 30_000 });
    await user.see({ text: "Everyone in the organization" });
    await user.see({ text: "All OpenRouter models" });
    await user.screenshot();
  });

  await step("the admin pastes a key and keeps the defaults: everyone, all models", async () => {
    await user.type({ testId: "gateway-provider-api-key" }, "sk-or-synthetic-journey-key");
    await user.click({ testId: "gateway-provider-save" });
    await user.see({ testId: "gateway-provider-replace-key" }, { timeoutMs: 30_000 });
    await user.notSee({ text: "sk-or-synthetic-journey-key" });
    const providers = await world.providers();
    const saved = providers[0];
    const ok = providers.length === 1 && saved !== undefined && Array.isArray(saved.modelIds) && saved.modelIds.length === 0
      && grantsOf(saved).some((grant) => grant.includes('"type":"organization"'));
    expect(ok).toBe(true);
    evidence.recordAssertionEvidence("One save creates the provider with its key, all models and an everyone grant", `providers=${providers.length}; grants=${saved ? grantsOf(saved).join(" ") : "none"}`, ok);
    await user.screenshot();
  });

  await step("after: AI Gateway shows one row that reads all models, everyone, ready", async () => {
    await user.click({ role: "link", label: "AI Gateway" });
    await user.see({ testId: "gateway-provider-open" }, { timeoutMs: 30_000 });
    await user.see({ text: "All models" });
    await user.see({ text: "Everyone" });
    await user.see({ text: "Ready" });
    await user.screenshot();
  });

  await step("the admin opens the row, turns Everyone off, adds Marketing and picks one model", async () => {
    await user.click({ testId: "gateway-provider-open" });
    await user.see({ testId: "gateway-provider-form" }, { timeoutMs: 30_000 });
    await user.click({ role: "button", label: /Everyone in the organization/ });
    await user.click({ role: "button", label: "Add team" });
    await user.click({ text: "Marketing" });
    await user.click({ role: "button", label: "Grant" });
    await user.click({ testId: "gateway-models-pick" });
    await user.type({ placeholder: "Filter models" }, "gpt-4o-mini");
    await user.click({ testId: "gateway-model-openai/gpt-4o-mini" });
    await user.see({ text: "Unsaved changes" });
    await user.screenshot();
    await user.click({ testId: "gateway-provider-save" });
    await user.notSee({ text: "Unsaved changes" }, { timeoutMs: 30_000 });
  });

  await step("after: the row reads one model for Marketing", async () => {
    await user.click({ role: "link", label: "AI Gateway" });
    await user.see({ text: "1 model" }, { timeoutMs: 30_000 });
    await user.see({ text: "Marketing" });
    const [provider] = await world.providers();
    const grants = provider ? grantsOf(provider) : [];
    const ok = grants.length === 1 && grants[0]?.includes(world.marketingTeamId) === true
      && Array.isArray(provider?.modelIds) && provider.modelIds.length === 1;
    expect(ok).toBe(true);
    evidence.recordAssertionEvidence("Only a Marketing grant remains and the provider serves one model", `grants=${grants.join(" ")}; modelIds=${JSON.stringify(provider?.modelIds)}`, ok);
    await user.screenshot();
  });

  await step("a Marketing teammate can connect; a teammate outside Marketing cannot", async () => {
    const [provider] = await world.providers();
    const id = typeof provider?.id === "string" ? provider.id : "";
    const inside = await probe.api(world.marketer, `/v1/inference-providers/${encodeURIComponent(id)}/connect`);
    const outside = await probe.api(world.outsider, `/v1/inference-providers/${encodeURIComponent(id)}/connect`);
    const ok = inside.response.ok && !outside.response.ok;
    expect(ok).toBe(true);
    evidence.recordAssertionEvidence("Marketing teammate connects; Support teammate is refused", `marketing=HTTP ${inside.response.status}; support=HTTP ${outside.response.status}`, ok);
  });
});
