import assert from "node:assert/strict";
import { test } from "node:test";
import { Marked } from "marked";
import {
  LONG_REPLY_FOLD_CHARS,
  documentCardPreview,
  documentCardsFromCalls,
  shouldFoldReply,
  splitReplyLead,
  wroteDocument,
} from "./documents.ts";

test("the fold applies to a long finished reply with no document behind it, and keeps every word", () => {
  const short = "Done. The plan is in Launch plan.";
  const long = `${"A sentence that keeps going. ".repeat(50)}\n\nSecond paragraph.\n\nThird paragraph.`;
  assert.ok(long.length > LONG_REPLY_FOLD_CHARS);
  const wrote = [{ tool: "coworker_document_create", status: "completed" }];
  const noDocument = [{ tool: "edit", status: "completed" }];
  assert.equal(shouldFoldReply(short, noDocument), false);
  assert.equal(shouldFoldReply(long, noDocument), true);
  assert.equal(shouldFoldReply(long, wrote), false);
  assert.equal(shouldFoldReply(long, [{ tool: "coworker_document_create", status: "error" }]), true);
  assert.equal(wroteDocument([{ tool: "coworker_document_read", status: "completed" }]), false);
  const split = splitReplyLead(long);
  assert.equal(split.lead, "A sentence that keeps going. ".repeat(50).trimEnd());
  assert.equal(split.rest, "Second paragraph.\n\nThird paragraph.");
  assert.equal(`${split.lead} ${split.rest}`.replace(/\s+/g, " "), long.replace(/\s+/g, " "), "the fold hides words; it never drops them");
});

test("reply folds use safe Markdown boundaries and retain reference links in the lead", () => {
  const parser = new Marked({ gfm: true, breaks: true, async: false });
  const intro = "This is the lead paragraph. ".repeat(4).trimEnd();
  for (const body of [
    "```md\nfirst\n\n- literal list\n\nlast\n```\n\nFollowing prose.",
    "- first\n\n  continued\n\n- second\n\nFollowing prose.",
    "| Name | Value |\n| --- | --- |\n| One | Two |\n\nFollowing prose.",
  ]) {
    const split = splitReplyLead(`${intro}\n\n${body}`);
    assert.equal(split.lead, intro);
    assert.equal(split.rest, body);
    assert.equal(parser.parse(split.leadMarkdown, { async: false }) + parser.parse(split.rest, { async: false }), parser.parse(`${intro}\n\n${body}`, { async: false }));
    assert.equal(splitReplyLead(body).rest, "", "structured content alone stays unfolded");
    assert.equal(splitReplyLead(`Done.\n\n${body}`).rest, "", "a tiny lead keeps the next intact block rather than cutting it");
  }
  const tiny = splitReplyLead("Done.\n\nDetails.\n\nRemaining content.");
  assert.equal(tiny.lead, "Done.\n\nDetails.");
  assert.equal(tiny.rest, "Remaining content.");
  assert.equal(splitReplyLead("One long paragraph. ".repeat(100)).rest, "");
  const linked = splitReplyLead(`${intro} See [guide].\n\nMore detail.\n\n[guide]: https://example.com/docs`);
  assert.match(parser.parse(linked.leadMarkdown, { async: false }), /<a href="https:\/\/example.com\/docs">guide<\/a>/);
  assert.equal(linked.lead, `${intro} See [guide].`);
  assert.equal(linked.rest, "More detail.\n\n[guide]: https://example.com/docs");
});

test("document attachments bound previews and keep the latest saved receipt per document in a turn", () => {
  const summary = `  Saved\n\t${"detail ".repeat(40)}`;
  const saved = { id: "brief", title: "Saved title", summary, highlights: ["First highlight", "Second highlight", "Third highlight", "Fourth highlight"] };
  const receipt = (revision: number, document = saved, tool = "coworker_document_update") => ({
    tool, status: "completed", input: { id: "input-id", title: "Input title", summary: "Input summary" }, output: "",
    metadata: { openworkMcpResult: { content: [], structuredContent: { document: { ...document, revision } } } },
  });
  const cards = documentCardsFromCalls([
    receipt(1, saved, "coworker_document_create"), receipt(3), receipt(2, { ...saved, title: "Stale title" }),
    { ...receipt(4), status: "error" },
    { ...receipt(4), metadata: { openworkMcpResult: { content: [], structuredContent: { document: { ...saved, revision: 4, action: "unchanged" } } } } },
  ]);
  assert.equal(cards.length, 1);
  const card = cards[0]!;
  assert.deepEqual(card, { ...saved, summary: summary.trim(), action: "created", section: "", revision: 3 });
  assert.equal(documentCardPreview(card), `${summary.replace(/\s+/g, " ").trim().slice(0, 139).trimEnd()}…`);
  assert.ok(documentCardPreview(card).length <= 140);
  assert.equal(documentCardPreview({ summary: " \n ", highlights: [" First\n\thighlight ", "Not rendered"] }), "First highlight");
  assert.equal(documentCardPreview({ summary: "", highlights: ["x".repeat(200)] }), `${"x".repeat(139)}…`);
  assert.equal(documentCardPreview({ summary: "", highlights: [] }), "");
  assert.equal(documentCardsFromCalls([receipt(4)])[0]?.action, "updated", "another turn keeps its own card");
  const cleared = documentCardsFromCalls([receipt(1), receipt(2, { ...saved, summary: "", highlights: [] })])[0]!;
  assert.equal(cleared.summary, "");
  assert.deepEqual(cleared.highlights, []);
  const nativeCreated = {
    tool: "coworker_document_create", status: "completed", input: { title: "Brief" },
    output: [{ type: "text", text: 'Wrote "Brief" (id brief-2, revision 1)' }],
    metadata: { structuredContent: { document: { ...saved, id: "brief-2", revision: 1 } } },
  };
  const nativeUpdated = { ...nativeCreated, tool: "coworker_document_update", input: { id: "brief-2" },
    metadata: { structuredContent: { document: { ...saved, id: "brief-2", title: "Updated brief", revision: 2 } } } };
  const native = documentCardsFromCalls([nativeCreated, nativeUpdated]);
  assert.equal(native.length, 1);
  assert.equal(native[0]?.id, "brief-2", "a native receipt must beat a title-derived ID collision");
  assert.equal(native[0]?.revision, 2);
  assert.equal(native[0]?.title, "Updated brief");
  assert.equal(documentCardsFromCalls([{ ...nativeCreated, metadata: {} }])[0]?.id, "brief-2", "native text content remains a receipt fallback");
  assert.equal(documentCardsFromCalls([{ ...nativeUpdated, metadata: { structuredContent: { document: { ...saved, action: "unchanged" } } } }]).length, 0);
  assert.equal(documentCardsFromCalls([{ ...nativeCreated, metadata: { ...nativeCreated.metadata, isError: true } }]).length, 0);
});
