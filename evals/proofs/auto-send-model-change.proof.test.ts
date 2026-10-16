import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { autoSendModelChange } from "../worlds/chat.ts";

const test = spec.world(autoSendModelChange, {
  timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["mock"] },
});

test("a member who changes model before an Auto message is sent gets the message back with a reason", async ({ world, user, probe, step, evidence }) => {
  const prompt = "Summarize the launch checklist for the team.";
  const option = (model: { providerID: string; modelID: string }) => ({ testId: `model-option-${model.providerID}-${model.modelID}` });
  const pickerClosed = () => probe.eventually(() => probe.dom('[data-testid="composer-model-picker"]'), {
    within: 5_000, label: "model selection closes the picker", until: (snapshot) => snapshot.elements.length === 0,
  });

  await step("the member picks Auto and sends a message while Auto access is still being checked", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.click(option(world.auto));
    await pickerClosed();
    await user.see({ role: "button", label: "Change model" }, { text: /^Auto$/ });
    await world.holdAutoCheck();
    await user.type("composer", prompt, { verify: true });
    await user.press("Enter");
    await probe.eventually(() => world.autoCheckAttempts(), {
      within: 15_000, label: "the Auto access check starts", until: (attempts) => attempts === 1,
    });
    await user.see("composer", { text: "" });
    await user.screenshot();
  });

  await step("before the check returns, the member switches to their own model", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.click(option(world.byok));
    await pickerClosed();
    await user.see({ role: "button", label: "Change model" }, { text: /^BYOK witness$/ });
    await world.releaseAutoCheck();
  });

  await step("after: the message is back in the composer with \"Message not sent\", and no model received it", async () => {
    await user.see({ testId: "session-error-card" }, { text: /Message not sent/, timeoutMs: 15_000 });
    await user.see("composer", { text: prompt });
    const sentBubbles = (await probe.dom('[data-message-role="user"]')).elements.length;
    const modelRequests = (await world.requests()).length;
    evidence.recordAssertionEvidence("the returned message explains that it was not sent",
      `error card: "Message not sent"; composer holds the original text; ${sentBubbles} sent messages; ${modelRequests} model requests`,
      sentBubbles === 0 && modelRequests === 0);
    expect(sentBubbles).toBe(0);
    expect(modelRequests).toBe(0);
    await user.screenshot();
  });
});
