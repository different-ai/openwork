import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { legacyProviderCredentialRemoval, legacyProviderCredentialRemovalOff } from "../worlds/legacy-provider-credential-removal.ts";
import { isRecord, records } from "../worlds/library.ts";

const test = spec.world(legacyProviderCredentialRemoval, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 420_000 });
const off = spec.world(legacyProviderCredentialRemovalOff, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 420_000 });
const within = 60_000;

test("a provider owner removes a saved organization key without losing the provider, models or access", async ({ world, user, probe, step, evidence }) => {
  async function readProvider() {
    const read = await probe.api(world.den.admin, "/v1/llm-providers?scope=manageable");
    expect(read.response.status).toBe(200);
    const provider = isRecord(read.body) ? records(read.body.llmProviders).find((row) => row.id === world.id) : null;
    if (!provider) throw new Error("The same provider must remain listed");
    return provider;
  }
  const before = await readProvider();
  await step("before: the shared provider has a saved credential and its model and access remain visible", async () => {
    await user.see({ text: "Credential saved" }, { timeoutMs: within });
    await user.see({ text: "Fixture model" });
    await user.see({ testId: "llm-provider-remove-credential" });
    expect(before.hasApiKey).toBe(true);
    evidence.recordAssertionEvidence("the saved credential is the starting state", `hasApiKey=${String(before.hasApiKey)}; same provider listed=true`, before.hasApiKey === true);
    await user.screenshot();
  });
  await step("removal asks for consent and Cancel sends no removal request", async () => {
    await user.click({ testId: "llm-provider-remove-credential" });
    await user.see({ testId: "confirm-dialog" }, { timeoutMs: within });
    const dialog = (await probe.dom('[data-testid="confirm-dialog"]')).elements.map((entry) => entry.text).join(" ");
    expect(dialog).toContain("next sync");
    expect(dialog).toContain("offline or signed-out");
    expect(dialog).toContain("does not revoke the key upstream");
    await user.screenshot();
    await user.click({ testId: "confirm-dialog-cancel" });
    await user.notSee({ testId: "confirm-dialog" });
    await user.see({ text: "Credential saved" });
    expect(await world.removals()).toHaveLength(0);
    evidence.recordAssertionEvidence("Cancel keeps the saved key and sends nothing", "removal requests=0; Credential saved remains visible", (await world.removals()).length === 0);
  });
  await step("a failed removal stays in the confirmation with an error and leaves the saved credential unchanged", async () => {
    await world.rejectRemoval();
    await user.click({ testId: "llm-provider-remove-credential" });
    await user.click({ testId: "confirm-dialog-action" });
    await user.see({ text: "Could not remove the saved key. Try again." }, { timeoutMs: within });
    await user.see({ testId: "confirm-dialog" });
    expect((await readProvider()).hasApiKey).toBe(true);
    const removals = await world.removals();
    expect(removals).toHaveLength(1);
    expect(removals[0]?.status).toBe(503);
    evidence.recordAssertionEvidence("the rejected write is not shown as a success", `removal requests=${removals.length}; HTTP=${removals[0]?.status}; hasApiKey=true`, removals.length === 1 && removals[0]?.status === 503);
    await user.screenshot();
  });
  await step("confirming again disables both dialog actions while the single removal is in flight", async () => {
    await world.delayRemoval();
    await user.click({ testId: "confirm-dialog-action" });
    const disabled = await probe.eventually(() => probe.dom('[data-testid="confirm-dialog"] button:disabled'), {
      within: 1000, label: "both confirmation actions are disabled during the delayed write", until: (value) => value.elements.length === 2,
    });
    expect(disabled.elements).toHaveLength(2);
    evidence.recordAssertionEvidence("the pending action cannot be sent twice or dismissed", `disabled dialog buttons=${disabled.elements.length}`, disabled.elements.length === 2);
    await user.screenshot();
  });
  await step("after: Credential missing replaces Credential saved and the same provider, models and grants remain", async () => {
    await user.notSee({ testId: "confirm-dialog" }, { timeoutMs: within });
    await user.see({ text: "Credential missing" }, { timeoutMs: within });
    await user.see({ text: "Saved key removed. Provider, models and access kept." });
    await user.see({ text: "Fixture model" });
    const after = await readProvider();
    expect(after.hasApiKey).toBe(false);
    expect(after.id).toBe(before.id);
    expect(after.providerConfig).toEqual(before.providerConfig);
    expect(after.credentialMode).toBe(before.credentialMode);
    expect(after.models).toEqual(before.models);
    expect(after.access).toEqual(before.access);
    const removals = await world.removals();
    expect(removals.map((request) => request.status)).toEqual([503, 204]);
    evidence.recordAssertionEvidence("only the credential changed after the confirmed server write", "hasApiKey=false; provider identity, definition, mode, models and grants unchanged; one successful DELETE", after.hasApiKey === false && removals.filter((request) => request.status === 204).length === 1);
    await user.screenshot();
  });
});

off("an owner without the rollout keeps the saved credential and cannot invoke removal", async ({ world, user, probe, step, evidence }) => {
  await step("before: an owner still sees the saved credential when the feature is off", async () => {
    await user.see({ text: "Credential saved" }, { timeoutMs: within });
    await user.see({ text: "Fixture model" });
    evidence.recordAssertionEvidence("turning the feature off does not erase provider state", "Credential saved and Fixture model visible", true);
    await user.screenshot();
  });
  await step("the removal entry is locked and names who can enable it", async () => {
    await user.see({ text: "Saved key removal is not enabled. Contact your OpenWork administrator." });
    const locked = await probe.dom('[data-testid="llm-provider-remove-credential"]:disabled');
    expect(locked.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("the disabled rollout offers no executable removal", `disabled removal buttons=${locked.elements.length}`, locked.elements.length === 1);
    await user.screenshot();
  });
  await step("after: reloading keeps the credential and sends no removal request", async () => {
    await user.reload();
    await user.see({ text: "Credential saved" }, { timeoutMs: within });
    await user.notSee({ testId: "confirm-dialog" });
    expect(await world.removals()).toHaveLength(0);
    evidence.recordAssertionEvidence("feature off preserves the existing behavior", "removal requests=0; Credential saved remains visible", (await world.removals()).length === 0);
    await user.screenshot();
  });
});
