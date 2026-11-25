import assert from "node:assert/strict";
import test from "node:test";
import { checkProse, isProseFile, proseLines } from "./check-prose-habits.mjs";

const rulesFor = (content) => checkProse("docs/a.md", content, new Set(content.split("\n").map((_, index) => index + 1))).map((finding) => finding.rule);

test("flags dashes, AI vocabulary, wordy and filler phrases, chatbot lines and curly quotes", () => {
  assert.deepEqual(rulesFor("Fast \u2014 and safe."), ["no-dash"]);
  assert.deepEqual(rulesFor("Fast - and safe."), ["no-dash"]);
  assert.deepEqual(rulesFor("This is a crucial step."), ["no-ai-vocabulary"]);
  assert.deepEqual(rulesFor("The file serves as the index."), ["no-serves-as"]);
  assert.deepEqual(rulesFor("It is not just fast, but safe."), ["no-not-just"]);
  assert.deepEqual(rulesFor("Let me know if anything breaks."), ["no-chatbot-phrase"]);
  assert.deepEqual(rulesFor("Run it in order to sync."), ["no-wordy-phrase"]);
  assert.deepEqual(rulesFor("Simply run it."), ["no-filler-word"]);
  assert.deepEqual(rulesFor("It\u2019s done."), ["no-curly-quotes"]);
});

test("allows list markers, table rules, empty cells, number ranges and arrows", () => {
  assert.deepEqual(rulesFor("- one item\n1. two\n| a | b |\n| --- | :-: |\n| x | \u2014 |\nLifetimes are 10\u20131440 minutes.\nclick \u2192 applied"), []);
});

test("skips code blocks, inline code, links, HTML comments and indented code", () => {
  const content = "```sh\necho \u2014 simply\n```\nRun `a -- b` now.\n[guide](https://x.test/simply-easy)\n<!-- simply -->\n\n    simply indented code\n";
  assert.deepEqual(rulesFor(content), []);
  assert.deepEqual(proseLines("a\n```\nb\n```\nc").map((line) => line.line), [1, 5]);
});

test("only fails on added lines", () => {
  assert.deepEqual(checkProse("docs/a.md", "Simply one.\nSimply two.", new Set([2])).map((finding) => finding.line), [2]);
});

test("checks markdown outside dependencies and changelogs", () => {
  assert.equal(isProseFile("docs/features/a/README.md"), true);
  assert.equal(isProseFile("AGENTS.md"), true);
  assert.equal(isProseFile("node_modules/x/README.md"), false);
  assert.equal(isProseFile("apps/desktop/CHANGELOG.md"), false);
  assert.equal(isProseFile("docs/a.ts"), false);
});
