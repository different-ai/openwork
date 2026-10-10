import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { modelPickerDeploymentDisabledAuto, modelPickerDisabledAuto } from "../worlds/chat.ts";

const test = spec.world(modelPickerDisabledAuto, {
  timeout: 420_000,
  resources: {
    surfaces: ["desktop"], services: ["den", "mock"],
    nativeReason: "The Auto status query and initial model choice run only in Electron against the native local relay.",
  },
});

const deploymentTest = spec.world(modelPickerDeploymentDisabledAuto, {
  timeout: 420_000,
  resources: {
    surfaces: ["desktop"], services: ["den", "mock"],
    nativeReason: "The deployment opt-out is applied by the native relay and consumed by the desktop Settings and model picker.",
  },
});

deploymentTest("a deployment-disabled Auto stays out of Settings and new tasks while other models remain available", async ({ world, user, probe, step, evidence }) => {
  const option = (model: { providerID: string; modelID: string }) => ({ testId: `model-option-${model.providerID}-${model.modelID}` });
  await step("before: a saved Auto preference does not interrupt a new task on a deployment with Auto disabled", async () => {
    expect(await probe.desktopApi("/anonymous-inference/status")).toMatchObject({ status: 200, body: { state: "unavailable", code: "free_disabled" } });
    expect(await probe.storage("openwork.defaultModel")).toBe(`${world.auto.providerID}/${world.auto.modelID}`);
    await user.see({ role: "button", label: "Change model" }, { text: "Organization witness" });
    await user.click({ role: "button", label: "Change model" });
    await user.see(option(world.byok));
    await user.see(option(world.organization));
    await user.notSee(option(world.auto));
    await user.click(option(world.byok));
    evidence.recordAssertionEvidence("A saved Auto preference does not block a new task when the deployment disables Auto", "The local service reports Auto as free_disabled. With Auto saved as the default, the new task starts on the organization model, and the picker offers BYOK and organization models but not Auto.", true);
    await user.screenshot();
  });
  await step("after: Settings hides the disabled Auto offer and keeps the person's other providers", async () => {
    await user.click({ role: "button", label: "Account menu" });
    await user.click({ role: "menuitem", label: "Settings" });
    await user.click({ role: "button", label: /^AI Providers$/ });
    await user.see({ role: "heading", label: /^AI Providers$/, nth: 0 });
    await user.see({ text: /^BYOK provider$/ });
    expect(await probe.desktopApi("/anonymous-inference/status")).toMatchObject({ status: 200, body: { code: "free_disabled" } });
    await user.notSee({ testId: "settings-auto-provider" });
    await user.notSee({ text: "Auto is unavailable on this device or blocked by your organization administrator." });
    evidence.recordAssertionEvidence("Settings hides Auto when the deployment disables it", "AI Providers in Settings lists the BYOK provider and shows neither the Auto provider card nor an Auto-unavailable warning, while the local service still reports free_disabled.", true);
    await user.screenshot();
  });
});

test("a member with a saved Auto default can choose a working model while free access is switched off", async ({ world, user, probe, step, evidence }) => {
  const option = (model: { providerID: string; modelID: string }) => ({ testId: `model-option-${model.providerID}-${model.modelID}` });
  const draft = "Keep this draft while free access is switched off.";
  const quiet = async () => {
    await user.notSee(option(world.auto));
    await user.notSee({ testId: "auto-picker-recovery" });
    await user.notSee({ testId: "auto-first-use" });
    await user.notSee({ text: "Auto status unavailable" });
    await user.notSee({ text: "Temporarily unavailable" });
    await user.notSee({ text: "Saved selection" });
  };
  await step("before: the member opens a new task with free access switched off and an Auto preference saved", async () => {
    const status = await probe.api(world.den.admin, "/v1/inference/access");
    expect(status.response.status).toBe(200);
    expect(status.body).toMatchObject({ access: { reason: "free_disabled" } });
    expect(await probe.storage("openwork.defaultModel")).toBe(`${world.auto.providerID}/${world.auto.modelID}`);
    await user.see("composer", { editable: true });
    expect((await probe.dom('button[aria-label="Change model"]')).elements.map((element) => element.text)).not.toContain("Auto");
    await user.see({ role: "button", label: "Change model" }, { text: "Organization witness" });
    await user.type("composer", draft, { verify: true });
    expect((await probe.composer()).draftText).toBe(draft);
    await quiet();
    await user.screenshot();
  });
  await step("after: the picker quietly offers BYOK and organization models without an Auto recovery wall", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.see(option(world.byok));
    await user.see(option(world.organization));
    await quiet();
    expect((await probe.composer()).draftText).toBe(draft);
    await user.screenshot();
  });
  await step("choosing BYOK preserves the draft and leaves free access switched off", async () => {
    await user.click(option(world.byok));
    await user.see({ role: "button", label: "Change model" }, { text: "BYOK witness" });
    await user.see("composer", { text: draft });
    await quiet();
    expect((await probe.api(world.den.admin, "/v1/inference/access")).body).toMatchObject({ access: { reason: "free_disabled" } });
    evidence.recordAssertionEvidence("A member with a saved Auto default can pick another model without losing the draft", "Den reports free access as free_disabled. The new task starts on the organization model with no Auto recovery wall. Choosing BYOK switches the model, keeps the draft, and leaves free access off.", true);
    await user.screenshot();
  });
});
