import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { nativeDictation } from "../worlds/native-dictation.ts";

const test = spec.world(nativeDictation, { timeout: 90_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("a member dictates directly into Workbot and sends while words are still arriving", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("before: the microphone is absent while dictation is off", async () => {
    await user.see({ role: "textbox", label: "Message Workbot" });
    await user.notSee({ role: "button", label: "Dictate message" });
    evidence.recordAssertionEvidence("Dictation starts off", "The composer works without a microphone entry point", (await probe.dom("[data-native-dictation]")).elements.length === 0);
    await user.screenshot();
  });
  await step("after: a plain microphone starts live words without an extra panel", async () => {
    await user.navigate(`${world.url}?dictation=on&chat=sidechat000000001`);
    await world.installSpeech();
    await user.type({ role: "textbox", label: "Message Workbot" }, "Please ");
    await user.click({ role: "button", label: "Dictate message" });
    await user.see({ role: "button", label: "Stop dictation" });
    await world.recognize("plan the weak");
    await user.see({ role: "textbox", label: "Message Workbot" }, { value: "Please plan the weak" });
    await world.recognize("plan the week");
    await user.see({ role: "textbox", label: "Message Workbot" }, { value: "Please plan the week" });
    expect((await probe.dom("[data-dictation-waveform]")).elements).toHaveLength(1);
    expect((await probe.dom('[role="dialog"]')).elements).toHaveLength(0);
    expect(world.attempts()).toHaveLength(0);
    evidence.recordAssertionEvidence("Interim words update the draft without duplicating speech", "Please plan the week is editable; the waveform is inline; no message was sent", world.attempts().length === 0);
    await user.screenshot();
  });
  await step("live dictation fits in the composer at a narrow width", async () => {
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await user.see({ role: "textbox", label: "Message Workbot" }, { value: "Please plan the week" });
    const layout = await probe.dom("[data-workbot-composer]");
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    await user.see({ role: "button", label: "Stop dictation" });
    evidence.recordAssertionEvidence("Speech and Send remain together at phone width", "The mic and original waveform fit without extra prose or a popover", layout.documentWidth <= layout.viewportWidth);
    await user.screenshot();
  });
  await step("Send includes current interim words and late speech cannot refill the cleared draft", async () => {
    await user.click({ role: "button", label: "Send" });
    const sent = await probe.eventually(() => world.attempts(), { within: 5000, label: "the current words reach Workbot", until: attempts => attempts.length === 1 });
    expect(sent[0]).toMatchObject({ text: "Please plan the week" });
    await world.recognize("This late result must not appear");
    await user.see({ role: "textbox", label: "Message Workbot" }, { value: "" });
    await user.see({ role: "button", label: "Dictate message" });
    expect((await probe.dom("[data-dictation-waveform]")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Send commits speech once and stops the recognizer", "Please plan the week was sent; the next draft stays empty", world.attempts().length === 1);
    await user.screenshot();
  });
  await step("stopping dictation keeps the transcript for editing before a later send", async () => {
    await user.click({ role: "button", label: "Dictate message" });
    await world.recognize("Start with Monday");
    await user.see({ role: "textbox", label: "Message Workbot" }, { value: "Start with Monday" });
    await user.click({ role: "button", label: "Stop dictation" });
    await user.see({ role: "textbox", label: "Message Workbot" }, { value: "Start with Monday" });
    await user.click({ role: "button", label: "Dictate message" });
    await user.type({ role: "textbox", label: "Message Workbot" }, "Start with Tuesday", { replace: true });
    await user.see({ role: "button", label: "Dictate message" });
    await world.recognize("A late result must not overwrite the edit");
    await user.see({ role: "textbox", label: "Message Workbot" }, { value: "Start with Tuesday" });
    expect(world.attempts()).toHaveLength(1);
    await user.press("Enter");
    const sent = await probe.eventually(() => world.attempts(), { within: 5000, label: "the edited transcript is sent", until: attempts => attempts.length === 2 });
    expect(sent[1]).toMatchObject({ text: "Start with Tuesday" });
    evidence.recordAssertionEvidence("Stop keeps editable text without sending it", "The member corrected Monday to Tuesday and chose when to send", sent.length === 2);
    await user.screenshot();
  });
});
