import assert from "node:assert/strict";
import test from "node:test";
import { assertContinuedState, assertHeldState, parseProbeState } from "../src/checkpoint-probe.ts";

function state() {
  return {
    producer: { bootId: "producer", connections: 1, sessions: Array.from({ length: 10 }, (_, i) => `Session ${i + 1}`) },
    consumer: { bootId: "consumer", text: "one\ntwo\nthree\n", completed: false, failed: false },
    disk: "original",
  };
}

test("checkpoint parser rejects missing or malformed observations", () => {
  for (const value of [null, {}, { producer: {}, consumer: {} }, { ...state(), consumer: { ...state().consumer, text: null } },
    { ...state(), producer: { ...state().producer, sessions: [false] } }]) assert.throws(() => parseProbeState(value));
});

test("held checkpoint requires the full synthetic session list and unfinished stream", () => {
  assertHeldState(parseProbeState(state()));
  const missing = state(); missing.producer.sessions.pop();
  assert.throws(() => assertHeldState(parseProbeState(missing)));
  const completed = state(); completed.consumer.completed = true;
  assert.throws(() => assertHeldState(parseProbeState(completed)));
});

test("continuation rejects a restarted process, reconnected stream or truncated reply", () => {
  const before = parseProbeState(state());
  const after = state();
  after.consumer.completed = true;
  after.consumer.text += "four\nfive\nsix\n";
  assertContinuedState(before, parseProbeState(after));
  for (const bad of [
    { ...after, producer: { ...after.producer, bootId: "restarted" } },
    { ...after, consumer: { ...after.consumer, bootId: "restarted" } },
    { ...after, producer: { ...after.producer, connections: 2 } },
    { ...after, consumer: { ...after.consumer, text: "one\ntwo\nthree\n" } },
    { ...after, consumer: { ...after.consumer, failed: true } },
  ]) assert.throws(() => assertContinuedState(before, parseProbeState(bad)));
});
