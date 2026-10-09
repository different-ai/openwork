import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { gmailStep, workbotNaturalReplyWorld, workbotReplyWorld, type ReplyPart } from "../worlds/workbot-reply.ts";

const test = spec.world(workbotReplyWorld, { resources: { surfaces: ["appWeb"], services: [] }, needs: { placement: "local" }, timeout: 120_000 });
const composer = { label: "Message Workbot" };
const dots = '[aria-label="Workbot is processing"] .workbot-typing-dot';
const bubbles = "ol[aria-label='Conversation'] div.overflow-x-auto.rounded-bl-md";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ack = "Sure, give me a sec.";
const answer = "Two need a reply today: Priya needs your OK on the travel budget by Friday, and Sam wants to move Thursday's demo to next week. The rest is newsletters.";
const offer = "Want me to draft a reply to Priya?";
const text = (step: number, words: string): ReplyPart => ({ kind: "text", text: words, step });

test("a member watches Workbot answer without the conversation jumping", async ({ world, user, probe, step, evidence }) => {
  await step("before: the member's message waits with typing dots where the answer will appear", async () => {
    await user.navigate(world.url);
    await user.see({ text: "A design review at 3:30, then nothing after 5." });
    await world.watchMovement();
    await user.type(composer, "Any emails I need to answer?");
    await user.click({ role: "button", label: "Send" });
    await probe.eventually(async () => (await probe.dom(dots)).elements.length === 3, { within: 10_000, label: "Typing dots wait where the answer will appear" });
    await user.screenshot();
    evidence.recordAssertionEvidence("A sent message shows where the answer will come", "The member's message is in the conversation with typing dots under it, in the place Workbot's first words will take.", true);
  });

  await step("Workbot says a line, looks in Gmail and answers, one message per thing it says", async () => {
    // A short line before looking (a lookup the page doesn't show follows it)…
    await world.write(0, ack);
    world.store([text(0, ack)], 1);
    await user.see({ text: ack });
    await pause(600);
    // …then a Gmail search, which runs in the place the answer will take…
    world.store([text(0, ack), gmailStep("running")], 2);
    await user.see({ text: "Using Gmail" });
    await pause(500);
    world.store([text(0, ack), gmailStep("done")], 2);
    await pause(600);
    // …the answer, stored as soon as it is written while Workbot keeps its memory current…
    await world.write(2, answer);
    world.store([text(0, ack), gmailStep("done"), text(2, answer)], 3);
    await pause(400);
    // …and a closing offer in its own message.
    await world.write(3, offer);
    world.store([text(0, ack), gmailStep("done"), text(2, answer), text(3, offer)], 4, true);
    await user.see({ text: offer });
    await pause(1_000);
  });

  await step("after: the reply is in, nothing jumped back and no two messages became one", async () => {
    const movement = await world.movement();
    expect(movement).not.toBeNull();
    expect(movement?.down, `the conversation moved down ${movement?.down} times (${movement?.downPx}px)`).toBe(0);
    expect(movement?.merged).toBe(0);
    // The earlier answer, then the line, the answer and the offer, each its own bubble.
    expect((await probe.dom(bubbles)).elements.map((element) => element.text)).toEqual([
      "A design review at 3:30, then nothing after 5.",
      ack,
      answer,
      offer,
    ]);
    await user.see({ text: "Used Gmail" });
    expect((await probe.dom(dots)).elements).toHaveLength(0);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "The conversation only grows while Workbot answers",
      "Watched every frame from sending to the finished reply: the conversation never moved back down, the typing dots and the running Gmail step gave way to the words in place, and the line, the answer and the offer stayed three separate messages after the reply was stored.",
      true,
    );
  });
});

const natural = spec.world(workbotNaturalReplyWorld, { resources: { surfaces: ["appWeb"], services: [] }, needs: { placement: "local" }, timeout: 120_000 });
const week = "Here's your week: Monday is planning at 10, Tuesday has two customer calls,";
const today = "Today it's the design review at 3:30, and nothing after 5.";

natural("a member's follow-up changes Workbot's answer instead of waiting behind it", async ({ world, user, probe, step, evidence }) => {
  await step("before: Workbot is partway through summarizing the week", async () => {
    await user.navigate(world.url);
    await user.see({ text: "A design review at 3:30, then nothing after 5." });
    await world.watchMovement();
    await user.type(composer, "Summarize my week");
    await user.click({ role: "button", label: "Send" });
    await world.write(0, week);
    await user.see({ text: week });
    await user.screenshot();
    evidence.recordAssertionEvidence("An answer is being written", "Workbot is partway through the week when the member decides they only want today.", true);
  });

  await step("the member sends a correction while it is still writing", async () => {
    await user.type(composer, "Actually, just today.");
    await user.click({ role: "button", label: "Send" });
    // The dots move under the correction: that is what Workbot answers next.
    await probe.eventually(async () => (await probe.dom(`ol[aria-label='Conversation'] > li:last-child ${dots}`)).elements.length === 3, { within: 10_000, label: "Typing dots under the correction" });
    expect((await probe.dom(`ol[aria-label='Conversation'] > li:nth-last-child(2) ${dots}`)).elements).toHaveLength(0);
    await user.notSee({ text: "Up next" });
    await world.write(0, "Got it, just today.");
    world.store([text(0, "Got it, just today.")], 1);
    await pause(400);
    await world.write(1, today);
    world.store([text(0, "Got it, just today."), text(1, today)], 2, true);
    await user.see({ text: today });
    await pause(1_000);
  });

  await step("after: the answer to the correction sits under it, and the cut-off answer just ends", async () => {
    await user.see({ text: week });
    await user.notSee({ text: "Stopped" });
    await user.notSee({ text: "Up next" });
    const rows = (await probe.dom("ol[aria-label='Conversation'] > li")).elements.map((element) => element.text);
    expect(rows.at(-1)).toContain("Actually, just today.");
    expect(rows.at(-1)).toContain(today);
    expect(rows.at(-2)).toContain(week);
    const movement = await world.movement();
    expect(movement?.down, `the conversation moved down ${movement?.down} times (${movement?.downPx}px)`).toBe(0);
    expect((await probe.dom(dots)).elements).toHaveLength(0);
    // Copy sits beside the finished answer's last bubble instead of adding a row under it.
    expect((await probe.dom("ol[aria-label='Conversation'] > li:last-child div.items-end button[aria-label='Copy answer']")).elements).toHaveLength(1);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "A follow-up is answered like a person would",
      "The answer about the week stopped where it was, with no Stopped label and nothing waiting Up next; the answer about today came under the correction with Copy beside its last bubble, and the conversation never moved back down.",
      true,
    );
  });
});
