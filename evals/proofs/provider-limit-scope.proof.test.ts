import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { providerLimitScope, providerLimitScopeDefault } from "../worlds/provider-limit-scope.ts";
import { isRecord, records } from "../worlds/library.ts";

const test = spec.world(providerLimitScope, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });
const defaultTest = spec.world(providerLimitScopeDefault, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

defaultTest("an owner manages provider-specific limits without a feature override", async ({ world, user, probe, step, evidence }) => {
  await step("the default excludes providers with their own limit", async () => {
    await user.see({ text: "Providers without their own limit" }, { timeoutMs: 60_000 });
    await user.notSee({ text: "Not enforced while off" });
    const label = await probe.dom(`[data-policy-id="${world.defaultPolicyId}"] [data-testid="gateway-limit-provider-label"]`);
    expect(label.elements.map((entry) => entry.text).join()).toBe("Providers without their own limit");
    evidence.recordAssertionEvidence("the default names its actual admission scope", `default label=${label.elements.map((entry) => entry.text).join()}`, label.elements.length === 1 && label.elements[0]?.text === "Providers without their own limit");
    await user.screenshot();
  });
  await step("the default editor offers the generally available provider choices", async () => {
    await user.click({ role: "link", label: "Edit Default provider limit" });
    await user.see({ testId: "gateway-limit-editor" });
    await user.see({ role: "combobox", label: "Provider" }, { value: "Providers without their own limit", timeoutMs: 60_000 });
    await probe.eventually(() => probe.dom('[data-testid="gateway-limit-provider"] input:not(:disabled)'), {
      within: 60_000, until: (value) => value.elements.length === 1, label: "provider choices are verified and editable",
    });
    await user.click({ role: "combobox", label: "Provider" });
    await user.see({ role: "option", label: /Saved model provider/ });
    const enabled = await probe.dom('[data-testid="gateway-limit-provider"] input:not(:disabled)');
    expect(enabled.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("provider scope needs no rollout override", `editable provider pickers=${enabled.elements.length}`, enabled.elements.length === 1);
    await user.screenshot();
    await user.press("Escape");
    await user.click({ role: "link", label: "Cancel" });
  });
  await step("the saved provider policy remains separate from the default and editable", async () => {
    await user.click({ role: "link", label: "Edit Saved provider limit" });
    await user.see({ role: "combobox", label: "Provider" }, { value: "Saved model provider", timeoutMs: 60_000 });
    await probe.eventually(() => probe.dom('[data-testid="gateway-limit-provider"] input:not(:disabled)'), {
      within: 60_000, until: (value) => value.elements.length === 1, label: "provider choices are verified and editable",
    });
    await user.click({ role: "combobox", label: "Provider" });
    await user.see({ role: "option", label: /Providers without their own limit/ });
    const enabled = await probe.dom('[data-testid="gateway-limit-provider"] input:not(:disabled)');
    const read = await probe.api(world.den.admin, "/v1/gateway/usage-limit-policies");
    const retained = isRecord(read.body) ? records(read.body.policies).find((entry) => entry.id === world.policyId) : null;
    expect(retained?.providerId).toBe(world.providerId);
    expect(enabled.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("general availability preserves the saved policy scope", `retained provider=${retained?.providerId === world.providerId}; editable pickers=${enabled.elements.length}`, read.response.ok && retained?.providerId === world.providerId && enabled.elements.length === 1);
    await user.screenshot();
  });
});

test("an owner keeps a saved provider scope through slow and failed lookups and can retry the real choices", async ({ world, user, probe, step, evidence }) => {
  await step("a slow lookup retains the saved provider instead of presenting a complete default-only list", async () => {
    await user.see({ text: "Checking provider choices. The saved scope is unchanged." }, { timeoutMs: 60_000 });
    await user.see({ role: "combobox", label: "Provider" }, { value: "Saved provider (unverified)" });
    const disabled = await probe.dom('[data-testid="gateway-limit-provider"] input:disabled');
    expect(disabled.elements.length).toBe(1);
    evidence.recordAssertionEvidence("pending choices cannot replace the saved provider", `saved scope shown unverified; disabled provider pickers=${disabled.elements.length}`, disabled.elements.length === 1);
    await user.screenshot();
    await user.see({ role: "combobox", label: "Provider" }, { value: "Saved model provider", timeoutMs: 60_000 });
  });
  await step("a failed lookup offers retry and does not claim the provider was removed", async () => {
    await user.reload();
    await user.see({ text: "Could not verify provider choices. The saved scope is unchanged." }, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Retry providers" });
    await user.see({ role: "combobox", label: "Provider" }, { value: "Saved provider (unverified)" });
    await user.notSee({ text: "Removed provider" });
    const failed = (await world.faults.requestLog()).filter((entry) => entry.path.includes("inference-providers") && entry.status === 503);
    evidence.recordAssertionEvidence("lookup failure has an actual recovery action", `faulted provider requests=${failed.length}; retry shown; no removal claim`, failed.length === 1);
    expect(failed.length).toBe(1);
    await user.screenshot();
  });
  await step("after: retry restores choices and the default names providers without their own limit", async () => {
    await user.click({ role: "button", label: "Retry providers" });
    await user.see({ role: "combobox", label: "Provider" }, { value: "Saved model provider", timeoutMs: 60_000 });
    await user.click({ role: "combobox", label: "Provider" });
    await user.see({ role: "option", label: /Providers without their own limit/ });
    await user.notSee({ role: "option", label: /^All providers$/ });
    const read = await probe.api(world.den.admin, "/v1/gateway/usage-limit-policies");
    const saved = isRecord(read.body) ? records(read.body.policies).find((entry) => entry.id === world.policyId) : null;
    expect(saved?.providerId).toBe(world.providerId);
    evidence.recordAssertionEvidence("recovery leaves the stored scope untouched", `saved provider scope retained=${saved?.providerId === world.providerId}; default explicitly excludes providers with their own limit`, read.response.ok && saved?.providerId === world.providerId);
    await user.screenshot();
    await user.press("Escape");
  });
  await step("saving an amount change after recovery retains the existing provider assignment", async () => {
    await user.type({ testId: "gateway-limit-amount-month" }, "25", { replace: true });
    await user.click({ testId: "gateway-limit-save" });
    await user.see({ testId: "gateway-limit-row" }, { text: /Saved provider limit/, timeoutMs: 60_000 });
    const read = await probe.api(world.den.admin, "/v1/gateway/usage-limit-policies");
    const saved = isRecord(read.body) ? records(read.body.policies).find((entry) => entry.id === world.policyId) : null;
    const limit = records(saved?.limits).find((entry) => entry.timeframe === "month");
    expect(saved?.providerId).toBe(world.providerId);
    expect(String(limit?.costLimitMicroUsd)).toBe("25000000");
    evidence.recordAssertionEvidence("an unrelated edit cannot silently reset provider scope", `stored provider preserved=${saved?.providerId === world.providerId}; monthly amount=${String(limit?.costLimitMicroUsd)} microUSD`, read.response.ok && saved?.providerId === world.providerId && String(limit?.costLimitMicroUsd) === "25000000");
    await user.screenshot();
  });
});
