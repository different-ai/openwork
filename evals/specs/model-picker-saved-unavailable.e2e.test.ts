import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { modelPickerSavedUnavailable } from "../worlds/chat.ts";

const test = spec.world(modelPickerSavedUnavailable, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

test("a saved model the provider dropped stays visible in the picker with a reason and one way to recover", async ({ world, user, probe, step, evidence }) => {
  const option = (model: { providerID: string; modelID: string }) => ({ testId: `model-option-${model.providerID}-${model.modelID}` });
  await step("before: the saved default is a model the workspace provider no longer lists", async () => {
    expect(await probe.storage("openwork.defaultModel")).toBe(`${world.retired.providerID}/${world.retired.modelID}`);
    await user.see({ role: "button", label: "Change model" }, { timeoutMs: 120_000 });
  });
  await step("after: the picker keeps the saved row, says it is no longer available, and offers Refresh and the working model", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.see({ testId: "retained-selected-model" });
    await user.see({ text: /no longer available here/ });
    await user.see({ text: "Your saved model isn’t available here anymore." });
    await user.see({ role: "button", label: "Refresh" });
    // The notice row leads with the alert icon (Availability and recovery design), not bare text.
    expect((await probe.dom('[data-testid="composer-model-picker"] [role="status"] svg.lucide-circle-alert')).elements.length).toBeGreaterThan(0);
    await user.see(option(world.kept));
    await user.notSee(option(world.retired));
    evidence.recordAssertionEvidence("A dropped saved model stays named with one recovery action",
      "The saved default is a model the provider no longer lists. The picker shows it dimmed with “no longer available here”, a notice with Refresh, and the provider's working model to choose instead.", true);
    await user.screenshot();
  });
  await step("choosing the working model replaces the unavailable one", async () => {
    await user.click(option(world.kept));
    await user.see({ role: "button", label: "Change model" }, { text: "Kept witness" });
    await user.screenshot();
  });
});
