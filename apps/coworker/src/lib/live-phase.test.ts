import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveStream } from "./live-stream.ts";
import { isUnsettledToolStatus, livePhase, phaseWord, sinceMoment, thinkingAvailability, thinkingText, writingText } from "./live-phase.ts";

function stream(type: string, text: string, ended = false): LiveStream {
  return { messageId: "msg_reply", partId: `prt_${type}`, type, text, ended };
}

const STEP = { doing: "reading launch-plan.md" };

test("the phase comes from what is streaming, in order: label, tool, words, thinking", () => {
  assert.equal(livePhase({ label: "Sending", stream: null, activeStep: null, landedWords: "" }), "sending");
  assert.equal(livePhase({ label: "Retrying", stream: stream("text", "words"), activeStep: STEP, landedWords: "" }), "retrying");
  assert.equal(livePhase({ label: "Working", stream: stream("text", "words"), activeStep: STEP, landedWords: "" }), "tool", "a tool step under way wins over words");
  assert.equal(livePhase({ label: "Working", stream: stream("text", "The short"), activeStep: null, landedWords: "" }), "writing");
  assert.equal(livePhase({ label: "Thinking", stream: null, activeStep: null, landedWords: "Landed words" }), "writing", "landed words are words too");
  assert.equal(livePhase({ label: "Working", stream: stream("reasoning", "let me check"), activeStep: null, landedWords: "" }), "thinking", "a reasoning part streaming is thinking whatever the label says");
  assert.equal(livePhase({ label: "Working", stream: null, activeStep: null, landedWords: "" }), "thinking", "nothing yet is thinking");
  assert.equal(livePhase({ label: "Working", stream: stream("text", "   "), activeStep: null, landedWords: "" }), "thinking", "blank text is not words");
  assert.equal(livePhase({ label: "Working", stream: stream("text", "done", true), activeStep: null, landedWords: "" }), "thinking", "an ended text part the transcript has not shown yet does not count twice");
  assert.equal(livePhase({ label: "Working", stream: stream("", "first delta"), activeStep: null, landedWords: "" }), "thinking", "a part the engine has not named yet is not words yet");
});

test("the thinking to show is the streaming reasoning, else the landed reasoning", () => {
  assert.equal(thinkingText(stream("reasoning", "check the policy"), { text: "", reasoning: "" }), "check the policy");
  assert.equal(thinkingText(stream("text", "Because"), { text: "Because", reasoning: "landed thought" }), "landed thought");
  assert.equal(thinkingText(null, null), "");
  assert.equal(thinkingText(stream("reasoning", "   "), { text: "", reasoning: "kept" }), "kept");
});

test("the words for the live bubble never get shorter than what landed", () => {
  assert.equal(writingText(stream("text", "The short version:"), { text: "", reasoning: "" }), "The short version:");
  assert.equal(writingText(stream("text", "The short"), { text: "The short version: A, B, C.", reasoning: "" }), "The short version: A, B, C.", "a poll that already landed more wins");
  assert.equal(writingText(stream("reasoning", "thinking words"), { text: "landed", reasoning: "" }), "landed", "reasoning is never shown as the reply");
  assert.equal(writingText(null, null), "");
});

test("whether a model shared its thinking is decided per turn, once words arrived", () => {
  assert.equal(thinkingAvailability({ stream: stream("reasoning", "hm"), reply: null, wordsArrived: false }), "available");
  assert.equal(thinkingAvailability({ stream: null, reply: { text: "", reasoning: "" }, wordsArrived: false }), "not-yet");
  assert.equal(thinkingAvailability({ stream: stream("text", "Because"), reply: { text: "", reasoning: "" }, wordsArrived: true }), "none");
  assert.equal(thinkingAvailability({ stream: stream("text", "Because"), reply: { text: "", reasoning: "earlier thought" }, wordsArrived: true }), "available");
});

test("moments and words", () => {
  assert.equal(sinceMoment(1_000, 5_400), "4 s");
  assert.equal(sinceMoment(0, 60_000), "1 min");
  assert.equal(sinceMoment(0, 72_000), "1 min 12 s");
  assert.equal(sinceMoment(9_000, 5_000), "0 s", "a clock that moved back reads as zero, never negative");
  assert.deepEqual(["sending", "retrying", "tool", "writing", "thinking"].map((phase) => phaseWord(phase as Parameters<typeof phaseWord>[0])), ["Sending", "Retrying", "Using a tool", "Writing", "Thinking"]);
  assert.equal(isUnsettledToolStatus("running"), true);
  assert.equal(isUnsettledToolStatus("pending"), true);
  assert.equal(isUnsettledToolStatus("completed"), false);
  assert.equal(isUnsettledToolStatus("error"), false);
});
