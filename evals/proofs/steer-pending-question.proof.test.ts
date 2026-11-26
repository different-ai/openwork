import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { steerPendingQuestion } from "../worlds/steer-pending-question.ts";

const test = spec.world(steerPendingQuestion, {
  timeout: 180_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

test("a person can steer an agent that is waiting for an answer", async ({ world, user, probe, step, evidence }) => {
  const card = '[data-composer-interaction="question"]';
  await step("before: the agent waits for an answer to its question", async () => {
    await user.click({ testId: `sidebar-session-${world.session.sessionId}` });
    await user.see("composer", { editable: true, timeoutMs: 45_000 });
    await user.type("composer", world.ask);
    await user.press("Enter");
    await user.see({ text: world.question }, { timeoutMs: 40_000 });
    const waiting = (await probe.dom(card)).elements.length;
    evidence.recordAssertionEvidence("The agent is waiting for an answer", `Question visible: ${world.question}`, waiting === 1);
    expect(waiting).toBe(1);
    await user.screenshot();
  });

  await step("when: the person gives the agent a different instruction instead of answering", async () => {
    await user.type("composer", world.steer);
    await user.press(world.steerShortcut);
    const sent = await probe.eventually(async () => (await probe.dom('[data-message-role="user"]')).elements.map(element => element.text).join("\n"), {
      within: 20_000, label: "the follow-up appears in the conversation", until: text => text.includes(world.steer),
    });
    evidence.recordAssertionEvidence("The follow-up appears in the conversation", world.steer, sent.includes(world.steer));
    expect(sent).toContain(world.steer);
    await user.screenshot();
  });

  await step("after: the unanswered question is gone and the agent follows the new instruction", async () => {
    await user.see({ text: world.reply }, { timeoutMs: 40_000 });
    const waiting = (await probe.dom(card)).elements.length;
    evidence.recordAssertionEvidence("The question closes and the agent replies to the follow-up", `Open questions: ${waiting}. Agent reply: ${world.reply}`, waiting === 0);
    expect(waiting).toBe(0);
    await user.screenshot();
  });
});
