import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { record, rows } from "../worlds/org-invite.ts";
import { providerShareGuided } from "../worlds/provider-share-guided.ts";

const test = spec.world(providerShareGuided, {
  timeout: 720_000,
  resources: { surfaces: ["appWeb", "web"], services: ["den"] },
});
const WITHIN = 60_000;

test("sharing a device key ends on where the provider is and which copy this device keeps", async ({ world, user, probe, step, evidence }) => {
  const providers = async () => {
    const response = await world.providers();
    expect(response.response.ok, response.text).toBe(true);
    return rows(record(response.body).inferenceProviders);
  };
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });

  await step("the owner connects an OpenAI key on this device and signs in", async () => {
    await user.navigate(world.settingsUrl);
    await user.see({ role: "button", label: "Connect a provider" }, { timeoutMs: WITHIN });
    await user.click({ role: "button", label: "Connect a provider" });
    await user.type({ label: "Search providers" }, "OpenAI");
    await user.click({ role: "button", label: /^OpenAI/ });
    if (await probe.has("Choose how you'd like to connect.")) await user.click({ role: "button", label: /API key/i });
    await user.type({ label: "API key" }, world.key, { sensitive: true });
    await user.click({ role: "button", label: "Save key" });
    await user.notSee({ role: "button", label: "Save key" }, { timeoutMs: WITHIN });
    await user.navigate(`${world.app.webUrl}/settings/cloud-account`);
    await user.see({ role: "button", label: "Paste sign-in code" }, { timeoutMs: WITHIN });
    await user.click({ role: "button", label: "Paste sign-in code" });
    await user.type({ role: "textbox", label: "Sign-in link or one-time code" }, await world.ownerGrant());
    await user.click({ role: "button", label: "Finish sign-in" });
    await user.notSee({ role: "button", label: "Finish sign-in" }, { timeoutMs: WITHIN });
    await user.navigate(world.settingsUrl);
    await user.see({ testId: "share-provider-openai" }, { timeoutMs: WITHIN });
    await user.screenshot();
  });

  await step("the confirmation says a copy goes to the organization", async () => {
    await user.click({ testId: "share-provider-openai" });
    await user.see({ testId: "share-provider-dialog" });
    await user.see({ text: /A copy is stored encrypted in AI Gateway/ });
    await user.screenshot();
  });

  let arrived = false;
  await step("after Share the dialog stays open and reports where the provider is", async () => {
    await user.click({ testId: "share-provider-confirm" });
    const dialog = await probe.eventually(() => probe.dom('[data-testid="share-provider-dialog"][data-step]'), {
      within: WITHIN, label: "the dialog reports the result of the share", until: (dom) => dom.elements.length === 1,
    });
    const text = dialog.elements[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    arrived = (await probe.dom('[data-testid="share-provider-dialog"][data-step="arrived"]')).elements.length === 1;
    const shared = await probe.eventually(providers, { within: WITHIN, label: "one organization provider", until: (value) => value.length === 1 });
    evidence.recordAssertionEvidence("The dialog reports the share instead of closing on a toast", `arrived on this device=${arrived}; organization providers=${shared.length}; dialog="${text.slice(0, 300)}"`, shared.length === 1);
    await user.screenshot();
    expect(shared).toHaveLength(1);
  });

  await step("the owner chooses which copy this device keeps", async () => {
    if (!arrived) {
      await user.see({ testId: "share-provider-check-again" });
      await user.click({ testId: "share-provider-check-again" });
      await probe.eventually(() => probe.dom('[data-testid="share-provider-check-again"]:not([disabled]), [data-testid="share-provider-use-organization"]'), {
        within: WITHIN, label: "the second check finishes", until: (dom) => dom.elements.length === 1,
      });
      arrived = (await probe.dom('[data-testid="share-provider-dialog"][data-step="arrived"]')).elements.length === 1;
      await user.screenshot();
    }
    expect(arrived, "the shared provider is listed under the organization on this device").toBe(true);
    await user.click({ testId: "share-provider-use-organization" });
    await probe.eventually(() => probe.dom('[data-testid="share-provider-dialog"], [data-testid="local-provider-openai"], [data-testid="share-provider-openai"]'), {
      within: WITHIN, label: "the dialog closes and the device row for OpenAI is gone", until: (dom) => dom.elements.length === 0,
    });
    const organizationRows = (await probe.dom('[data-provider-scope="organization"]')).elements.map((element) => element.text.replace(/\s+/g, " ").trim());
    const listed = organizationRows.some((row) => /OpenAI/.test(row));
    evidence.recordAssertionEvidence("The key is gone from this device and the provider is listed under the organization", `device row for OpenAI absent; organization rows=${JSON.stringify(organizationRows).slice(0, 400)}`, listed);
    await user.screenshot();
    expect(listed).toBe(true);
  });
});

test("model search lists only what was asked for and every provider is one choice away", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  const options = async (selector = "") => (await probe.dom(`[data-testid="palette-model-picker"] [data-testid^="model-option-"]${selector}`)).elements.length;

  await step("the owner has the same provider twice: their key and the organization's copy", async () => {
    await user.navigate(world.settingsUrl);
    await user.see({ role: "button", label: "Connect a provider" }, { timeoutMs: WITHIN });
    await user.click({ role: "button", label: "Connect a provider" });
    await user.type({ label: "Search providers" }, "OpenAI");
    await user.click({ role: "button", label: /^OpenAI/ });
    if (await probe.has("Choose how you'd like to connect.")) await user.click({ role: "button", label: /API key/i });
    await user.type({ label: "API key" }, world.key, { sensitive: true });
    await user.click({ role: "button", label: "Save key" });
    await user.notSee({ role: "button", label: "Save key" }, { timeoutMs: WITHIN });
    await user.navigate(`${world.app.webUrl}/settings/cloud-account`);
    await user.see({ role: "button", label: "Paste sign-in code" }, { timeoutMs: WITHIN });
    await user.click({ role: "button", label: "Paste sign-in code" });
    await user.type({ role: "textbox", label: "Sign-in link or one-time code" }, await world.ownerGrant());
    await user.click({ role: "button", label: "Finish sign-in" });
    await user.notSee({ role: "button", label: "Finish sign-in" }, { timeoutMs: WITHIN });
    await user.navigate(world.settingsUrl);
    await user.see({ testId: "share-provider-openai" }, { timeoutMs: WITHIN });
    await user.click({ testId: "share-provider-openai" });
    await user.click({ testId: "share-provider-confirm" });
    await user.see({ testId: "share-provider-keep-both" }, { timeoutMs: WITHIN });
    await user.click({ testId: "share-provider-keep-both" });
    await probe.eventually(() => probe.dom('[data-testid="share-provider-dialog"]'), { within: WITHIN, label: "the dialog closes", until: (dom) => dom.elements.length === 0 });
  });

  await step("Cmd+K, Models: one selector lists every provider with its model count", async () => {
    await user.press("Meta+K");
    await user.type({ role: "combobox" }, "Models");
    await user.click({ text: "Choose the LLM that runs your next prompts" });
    await user.see({ testId: "palette-model-picker" }, { timeoutMs: WITHIN });
    await probe.eventually(() => options(), { within: WITHIN, label: "models are listed", until: (count) => count > 0 });
    await user.see({ label: "Filter models by provider" });
    await user.click({ label: "Filter models by provider" });
    const choices = (await probe.eventually(() => probe.dom(`[data-slot="select-item"]`), { within: WITHIN, label: "the provider choices open", until: (dom) => dom.elements.some((element) => element.rect.width > 0) }))
      .elements.map((element) => element.text.replace(/\s+/g, " ").trim());
    evidence.recordAssertionEvidence("Every connected provider is one choice in the selector", JSON.stringify(choices), choices.length >= 3);
    await user.screenshot();
    expect(choices[0]).toBe("All providers");
    expect(choices.length).toBeGreaterThanOrEqual(3);
    expect(new Set(choices).size).toBe(choices.length);
    await user.press("Escape");
    await probe.eventually(() => probe.dom(`[data-slot="select-item"]`), { within: WITHIN, label: "Escape closes the provider choices", until: (dom) => dom.elements.every((element) => element.rect.width === 0) });
    await user.see({ label: "Search all models" });
  });

  await step("a provider plus a model word nobody serves is empty, and offers that provider's models", async () => {
    const all = await options();
    await user.type({ label: "Search all models" }, "openai zzqx");
    await probe.eventually(() => options(), { within: WITHIN, label: "no unrelated models fill the list", until: (count) => count === 0 });
    await user.see({ role: "button", label: /^Show all .* models$/ });
    await user.screenshot();
    await user.click({ role: "button", label: /^Show all .* models$/ });
    const scoped = await probe.eventually(async () => ({ total: await options(), openai: await options('[data-testid^="model-option-openai-"]'), organization: await options('[data-testid^="model-option-ipr_"]') }), {
      within: WITHIN, label: "only OpenAI models are listed", until: (count) => count.total > 0,
    });
    evidence.recordAssertionEvidence("The provider's models are listed and nothing else", `all=${all}; listed=${scoped.total}; device OpenAI=${scoped.openai}; organization OpenAI=${scoped.organization}`, scoped.total === scoped.openai + scoped.organization);
    await user.screenshot();
    expect(scoped.total).toBe(scoped.openai + scoped.organization);
  });
});
