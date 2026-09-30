import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { modelAccessPicker } from "../worlds/chat.ts";

const test = spec.world(modelAccessPicker, { timeout: 420_000 });

test("with \"Only models you provide\", the member's picker lists the organization's model and not their own key", async ({ world, user, probe, step, evidence }) => {
  const key = (model: { providerID: string; modelID: string }) => `${model.providerID}:${model.modelID}`;
  const count = async (selector: string) => (await probe.dom(selector)).elements.length;

  // The compact picker lists provider groups by name (models open in submenus), so read its text.
  // The list only exists once "Model" is opened; read the whole page so any listed provider shows up.
  const pickerText = async () => (await probe.dom("body")).elements.map((element) => element.text).join("\n");
  const rows = async () => {
    const text = await pickerText();
    return {
      open: (await count('input[placeholder="Search models..."]')) > 0,
      organization: text.includes("Organization provider") || text.includes("Organization witness") || (await count(`[data-model-key="${key(world.organization)}"]`)) > 0 ? 1 : 0,
      personal: text.includes("Personal provider") || text.includes("Personal witness") || (await count(`[data-model-key="${key(world.personal)}"]`)) > 0 ? 1 : 0,
      text: text.slice(0, 600),
    };
  };

  await step("before: the AI Gateway's model access is \"Only models you provide\"", async () => {
    evidence.recordAssertionEvidence("model access", JSON.stringify({ allowCustomProviders: world.policy.allowCustomProviders }), world.policy.allowCustomProviders === false);
    await user.see({ role: "button", label: "Change model" }, { timeoutMs: 120_000 });
  });

  await step("after: the picker offers the organization's model and hides the member's personal provider", async () => {
    // The composer can re-render while the engine settles, so reopen the menu until the model list shows.
    await probe.eventually(async () => {
      const list = await count('input[placeholder="Search models..."]');
      if (!list && (await count('[data-slot="model-select-root"]'))) await user.click({ role: "button", label: /^Model\b/ });
      else if (!list) await user.click({ role: "button", label: "Change model" });
      return { list: await count('input[placeholder="Search models..."]') };
    }, { within: 60_000, label: "model list opens", until: (state) => state.list > 0 });
    const listed = await probe.eventually(rows, {
      within: 90_000, label: "model access picker", until: (state) => state.open && state.organization > 0 && state.personal === 0,
    });
    evidence.recordAssertionEvidence("picker rows", JSON.stringify(listed), listed.organization > 0 && listed.personal === 0);
    expect(listed.organization).toBeGreaterThan(0);
    expect(listed.personal).toBe(0);
    await user.screenshot();
  });
});
