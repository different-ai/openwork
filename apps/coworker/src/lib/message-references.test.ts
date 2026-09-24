import assert from "node:assert/strict";
import { test } from "node:test";
import { linkDocumentMentions, mentionedDocuments, sharedLinks } from "./message-references.ts";

const briefing = { id: "jev-model-briefing", title: "Jev model briefing", summary: "An assessment of Jev.", highlights: [] };
const plan = { id: "launch-plan", title: "Launch plan", summary: "", highlights: [] };

test("a named document becomes one in-place link and a preview", () => {
  const reply = "Yes, one document:\n\n- **Jev model briefing** (`jev-model-briefing`): an assessment of TypeSafe AI's Jev model.";
  assert.deepEqual(mentionedDocuments(reply, [plan, briefing]).map((document) => document.id), ["jev-model-briefing"]);
  assert.equal(linkDocumentMentions(reply, [plan, briefing]), "Yes, one document:\n\n- **[Jev model briefing](doc:jev-model-briefing)**: an assessment of TypeSafe AI's Jev model.");
  assert.equal(linkDocumentMentions("See `launch-plan`, then **Jev model briefing**.", [plan, briefing]),
    "See [Launch plan](doc:launch-plan), then **[Jev model briefing](doc:jev-model-briefing)**.");
  assert.deepEqual(mentionedDocuments("Nothing about a Launch plan here in plain words.", [plan]), [], "only explicit mentions count");
});

test("shared links are found once each, in order, without trailing punctuation", () => {
  assert.deepEqual(sharedLinks("Sources: [docs](https://docs.typesafe.ai/jev), https://typesafe.ai. And https://docs.typesafe.ai/jev again, https://example.com/x"),
    ["https://docs.typesafe.ai/jev", "https://typesafe.ai"]);
  assert.deepEqual(sharedLinks("no links here"), []);
});
