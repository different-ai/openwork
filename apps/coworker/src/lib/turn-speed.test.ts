import assert from "node:assert/strict";
import { test } from "node:test";
import { FIRST_WORDS_CAP, FIRST_WORDS_KEY, describeSpan, describeSpeed, firstWordsFor, rememberFirstWords } from "./turn-speed.ts";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}

test("spans read in a person's units", () => {
  assert.equal(describeSpan(400), "under a second");
  assert.equal(describeSpan(949), "under a second");
  assert.equal(describeSpan(950), "1 s");
  assert.equal(describeSpan(1_840), "1.8 s");
  assert.equal(describeSpan(6_300), "6.3 s");
  assert.equal(describeSpan(9_960), "10 s");
  assert.equal(describeSpan(12_400), "12 s");
  assert.equal(describeSpan(65_000), "1 min 5 s");
  assert.equal(describeSpan(120_000), "2 min");
});

test("the speed line names only the facts it has, in the person's words", () => {
  assert.equal(describeSpeed({ sentAt: 1_000, firstWordsAt: 2_840, completedAt: 7_300, reasoningTokens: 320 }), "first words in 1.8 s · 6.3 s in all · 320 words of thinking");
  assert.equal(describeSpeed({ sentAt: 1_000, firstWordsAt: 1_400, completedAt: 4_000, reasoningTokens: 0 }), "first words in under a second · 3 s in all");
  assert.equal(describeSpeed({ sentAt: 1_000, firstWordsAt: null, completedAt: 4_000, reasoningTokens: null }), "3 s in all");
  assert.equal(describeSpeed({ sentAt: null, firstWordsAt: 5, completedAt: 9, reasoningTokens: 1_200 }), "1,200 words of thinking");
  assert.equal(describeSpeed({ sentAt: null, firstWordsAt: null, completedAt: null, reasoningTokens: null }), "");
  assert.equal(describeSpeed({ sentAt: 9_000, firstWordsAt: 5_000, completedAt: 4_000, reasoningTokens: null }), "", "a moment before the send is not a fact");
  assert.doesNotMatch(describeSpeed({ sentAt: 0, firstWordsAt: 1_000, completedAt: 2_000, reasoningTokens: 5 }), /token/i);
});

test("first-words moments are kept per reply, first one stands, bounded, and survive a torn store", () => {
  const storage = memoryStorage();
  rememberFirstWords(storage, "msg_1", 1_000);
  rememberFirstWords(storage, "msg_1", 2_000);
  assert.equal(firstWordsFor(storage, "msg_1"), 1_000);
  assert.equal(firstWordsFor(storage, "msg_2"), null);
  for (let index = 0; index < FIRST_WORDS_CAP + 10; index += 1) rememberFirstWords(storage, `bulk_${index}`, index);
  assert.equal(firstWordsFor(storage, "msg_1"), null, "the oldest moments go first");
  assert.equal(firstWordsFor(storage, `bulk_${FIRST_WORDS_CAP + 9}`), FIRST_WORDS_CAP + 9);
  assert.equal(JSON.parse(storage.data.get(FIRST_WORDS_KEY) ?? "[]").length, FIRST_WORDS_CAP);
  storage.data.set(FIRST_WORDS_KEY, "{not json");
  assert.equal(firstWordsFor(storage, "bulk_1"), null);
  rememberFirstWords(storage, "after", 7);
  assert.equal(firstWordsFor(storage, "after"), 7, "a torn store starts over rather than failing");
  rememberFirstWords(null, "nowhere", 1);
  assert.equal(firstWordsFor(null, "nowhere"), null);
});
