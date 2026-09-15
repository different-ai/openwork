import assert from "node:assert/strict";
import { test } from "node:test";
import { Marked } from "marked";
import { splitChatReply } from "./chat-replies.ts";

const parser = new Marked({ gfm: true, breaks: true, async: false });

function lossless(text: string) {
  const parts = splitChatReply(text);
  assert.equal(parts.map((part) => part.text).join(""), text);
  assert.ok(parts.length >= 1 && parts.length <= 3);
  let offset = 0;
  for (const part of parts) {
    assert.equal(part.start, offset);
    assert.equal(text.slice(part.start, part.start + part.text.length), part.text);
    offset += part.text.length;
  }
  return parts;
}

test("two deliberate prose thoughts become two bubbles, not sentences or soft lines", () => {
  const first = "That looks good. I'll keep the layout.\nThe behavior stays the same.";
  const second = "Next I'll check the change.";
  assert.deepEqual(lossless(`${first}\n\n${second}`).map((part) => part.text), [`${first}\n\n`, second]);
  assert.equal(lossless("A long sentence. ".repeat(200)).length, 1);
  assert.equal(lossless("").length, 1);
});

test("append-only streaming keeps completed earlier bubbles when structured content arrives", () => {
  for (const ending of ["```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nDone.", "- first\n\n  continued\n\n- second\n\nDone.", "| Name |\n| --- |\n| One |\n\nDone."]) {
    const text = `First thought.\n\nSecond thought.\n\n${ending}`;
    let previous = splitChatReply("");
    for (let length = 1; length <= text.length; length += 1) {
      const current = lossless(text.slice(0, length));
      assert.deepEqual(current.slice(0, previous.length - 1), previous.slice(0, -1));
      previous = current;
    }
    assert.deepEqual(previous.slice(0, 2).map((part) => part.text), ["First thought.\n\n", "Second thought.\n\n"]);
  }
});

test("structured blocks and their following content stay together after safe prose", () => {
  for (const block of [
    "```md\nfirst\n\n- literal list\n\nlast\n```",
    "~~~txt\nfirst\n\nlast\n~~~",
    "~~~txt\nfirst\n\nlast",
    "````txt\nfirst\n\n```\nlast",
    "- first\n\n  second paragraph\n\n  ```txt\n  code\n\n  more\n  ```\n\n- last",
    "    first\n\n    last",
    "| Name | Value |\n| --- | --- |\n| One | Two |\n\n| Other | Table |\n| --- | --- |\n| Three | Four |",
    "> first\n>\n> second\n\n> third",
    "<div>\nfirst\n\n<script>alert(1)</script>\n</div>",
  ]) {
    const body = `${block}\n\nFollowing prose.\n\nStill together.`;
    const parts = lossless(`Intro.\n\n${body}`);
    assert.deepEqual(parts.map((part) => part.text), ["Intro.\n\n", body]);
    assert.equal(parts.map((part) => parser.parse(part.markdown, { async: false })).join(""), parser.parse(`Intro.\n\n${body}`, { async: false }));
    assert.equal(lossless(body).length, 1);
  }
});

test("the three-bubble cap retains all remaining text and original mixed line endings", () => {
  const first = "\r\nFirst thought.\r\n\r\n";
  const second = "Second thought.\n\n";
  const rest = "Third thought.\r\rFourth thought.\n\nFifth thought.\r\n";
  assert.deepEqual(lossless(first + second + rest).map((part) => part.text), [first, second, rest]);
});

test("reference links retain full-reply definitions, titles, and first-definition precedence", () => {
  for (const text of [
    'See [the guide][guide].\n\nThen read [guide] and [guide][].\n\n[guide]: https://example.com/docs\n  "The guide"',
    'See [guide].\n\nAnother thought.\n\n[guide]: https://example.com/first "First"\n\n[guide]: https://example.com/second "Second"',
    'See [guide].\n\n- Details\n\n  [guide]: https://example.com/docs "Nested definition"',
  ]) {
    const parts = lossless(text);
    assert.equal(parts.length, 2);
    const rendered = parts.map((part) => parser.parse(part.markdown, { async: false })).join("");
    assert.equal(rendered, parser.parse(text, { async: false }));
    assert.match(rendered, /<a href="https:\/\/example.com\//);
  }
});

test("streaming potential reference definitions never creates a bubble that must merge away", () => {
  const text = "See [guide].\n\nAnother thought.\n\n[guide]: https://example.com/docs\n\nMore text.";
  let previous = splitChatReply("");
  for (let length = 1; length <= text.length; length += 1) {
    const current = lossless(text.slice(0, length));
    assert.deepEqual(current.slice(0, previous.length - 1).map(({ start, text }) => ({ start, text })), previous.slice(0, -1).map(({ start, text }) => ({ start, text })));
    previous = current;
  }
  assert.equal(previous.length, 2);
  assert.equal(lossless("First thought.\n\n[guide] is useful.\n\nMore text.").length, 1);
});

test("a late reference definition resolves earlier links without changing raw boundaries", () => {
  const prefix = "See [guide].\n\nAnother thought.\n\nFinal thought.";
  const before = lossless(prefix);
  const after = lossless(`${prefix}\n\n[guide]: https://example.com/docs`);
  assert.deepEqual(after.slice(0, 2).map(({ start, text }) => ({ start, text })), before.slice(0, 2).map(({ start, text }) => ({ start, text })));
  assert.match(parser.parse(after[0]!.markdown, { async: false }), /<a href="https:\/\/example.com\/docs">guide<\/a>/);
});
