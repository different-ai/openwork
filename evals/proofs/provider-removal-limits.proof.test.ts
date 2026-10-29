import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { providerRemovalLimits } from "../worlds/provider-removal-limits.ts";
import { isRecord, records } from "../worlds/library.ts";

const test = spec.world(providerRemovalLimits, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

test("an owner removing a provider moves its spend limit to the provider that replaces it", async ({ world, user, probe, step, evidence }) => {
  const readPolicy = async (id: string) => {
    const read = await probe.api(world.den.admin, "/v1/gateway/usage-limit-policies");
    return isRecord(read.body) ? records(read.body.policies).find((entry) => entry.id === id) ?? null : null;
  };
  await step("before: the $4,000 monthly cap applies to the old provider", async () => {
    await user.see({ text: "Acme monthly cap" }, { timeoutMs: 60_000 });
    const label = await probe.dom(`[data-policy-id="${world.policyId}"] [data-testid="gateway-limit-provider-label"]`);
    const text = label.elements.map((entry) => entry.text).join();
    evidence.recordAssertionEvidence("the cap is scoped to the old provider", `provider label=${text}`, text === "Old OpenRouter key");
    expect(text).toBe("Old OpenRouter key");
    await user.screenshot();
  });
  await step("removing the old provider names the cap and offers to move it to Acme OpenRouter", async () => {
    await user.navigate(world.providerUrl(world.oldProviderId));
    await user.see({ testId: "gateway-provider-remove" }, { timeoutMs: 60_000 });
    await user.click({ testId: "gateway-provider-remove" });
    await user.see({ testId: "gateway-provider-remove-limit" }, { text: /Acme monthly cap/, timeoutMs: 60_000 });
    await user.see({ text: "$4,000.00 a month" });
    await user.see({ text: "Move the limit to Acme OpenRouter" });
    await user.see({ text: "Delete the limit too" });
    const checked = await probe.dom('[data-testid="gateway-provider-remove-limits-move"]:checked');
    evidence.recordAssertionEvidence("moving to the remaining provider is the default choice", `move option checked=${checked.elements.length === 1}`, checked.elements.length === 1);
    expect(checked.elements).toHaveLength(1);
    await user.screenshot();
  });
  await step("after: the provider is gone and the same cap now applies to Acme OpenRouter", async () => {
    await user.click({ role: "button", label: "Remove provider" });
    await user.see({ text: "Legacy Providers" }, { timeoutMs: 60_000 });
    await user.notSee({ text: "Old OpenRouter key" });
    await user.navigate(world.limitsUrl);
    const label = await probe.eventually(() => probe.dom(`[data-policy-id="${world.policyId}"] [data-testid="gateway-limit-provider-label"]`), {
      within: 60_000, until: (value) => value.elements[0]?.text === "Acme OpenRouter", label: "the cap shows its new provider",
    });
    const text = label.elements.map((entry) => entry.text).join();
    const policy = await readPolicy(world.policyId);
    const moved = policy?.providerId === world.newProviderId && policy?.archivedAt === null && text === "Acme OpenRouter";
    evidence.recordAssertionEvidence("the cap moved instead of silently applying to nothing", `provider label=${text}; stored provider is the new one=${policy?.providerId === world.newProviderId}; archived=${String(policy?.archivedAt)}`, moved);
    expect(moved).toBe(true);
    await user.screenshot();
  });
});

test("an owner sees a limit whose provider was removed earlier and points it at a live provider", async ({ world, user, probe, step, evidence }) => {
  await step("before: the orphaned cap says its provider was removed and it is not applied", async () => {
    await user.see({ text: "Research monthly cap" }, { timeoutMs: 60_000 });
    const row = await probe.dom(`[data-policy-id="${world.orphanPolicyId}"]`);
    const text = row.elements.map((entry) => entry.text).join();
    const shown = text.includes("Provider removed") && text.includes("Not applied") && text.includes("Choose provider");
    evidence.recordAssertionEvidence("the orphaned cap is visible as not applied", `row=${text}`, shown);
    expect(shown).toBe(true);
    await user.screenshot();
  });
  await step("choosing a provider opens the limit with the removed provider called out", async () => {
    await user.click({ role: "link", label: "Choose a provider for Research monthly cap" });
    await user.see({ text: "This limit's provider was removed, so it applies to no one. Choose the provider it should cap." }, { timeoutMs: 60_000 });
    await user.see({ role: "combobox", label: "Provider" }, { value: "Removed provider", timeoutMs: 60_000 });
    await user.screenshot();
  });
  await step("after: the cap applies to Acme OpenRouter again", async () => {
    await probe.eventually(() => probe.dom('[data-testid="gateway-limit-provider"] input:not(:disabled)'), {
      within: 60_000, until: (value) => value.elements.length === 1, label: "provider choices are verified and editable",
    });
    await user.click({ role: "combobox", label: "Provider" });
    await user.click({ role: "option", label: /Acme OpenRouter/ });
    await user.click({ testId: "gateway-limit-save" });
    const row = await probe.eventually(() => probe.dom(`[data-policy-id="${world.orphanPolicyId}"]`), {
      within: 60_000, until: (value) => value.elements.length === 1 && value.elements[0]?.text.includes("Acme OpenRouter") === true, label: "the limits list shows the cap on Acme OpenRouter",
    });
    const read = await probe.api(world.den.admin, "/v1/gateway/usage-limit-policies");
    const policy = isRecord(read.body) ? records(read.body.policies).find((entry) => entry.id === world.orphanPolicyId) : null;
    const text = row.elements.map((entry) => entry.text).join();
    const fixed = policy?.providerId === world.newProviderId && policy?.providerStatus === "available" && !text.includes("Provider removed");
    evidence.recordAssertionEvidence("the cap governs a live provider again", `providerStatus=${String(policy?.providerStatus)}; row=${text}`, fixed);
    expect(fixed).toBe(true);
    await user.screenshot();
  });
});
