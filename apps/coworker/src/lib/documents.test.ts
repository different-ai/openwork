import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LONG_REPLY_FOLD_CHARS,
  askToUpdatePrompt,
  cardSubline,
  documentCardsFromCalls,
  documentToolName,
  documentsChangedSince,
  groupDocuments,
  humanizeDocumentId,
  isDocumentTool,
  shouldFoldReply,
  splitReplyLead,
  wroteDocument,
} from "./documents.ts";

function kept(document: Record<string, unknown>, text = "ok"): Record<string, unknown> {
  return { openworkMcpApp: { content: [{ type: "text", text }], structuredContent: { document } } };
}

test("document tool names are recognised with or without the MCP prefix", () => {
  assert.equal(documentToolName("coworker_document_create"), "document_create");
  assert.equal(documentToolName("document_update"), "document_update");
  assert.equal(documentToolName("Coworker_Context_Set"), "context_set");
  assert.equal(documentToolName("openwork-cloud_execute_capability"), "");
  assert.equal(isDocumentTool("coworker_documents_list"), true);
  assert.equal(isDocumentTool("edit"), false);
  assert.equal(humanizeDocumentId("launch-plan-q3"), "Launch plan q3");
  assert.equal(humanizeDocumentId(""), "Document");
});

test("a card comes from the tool call's input alone, and prefers the kept result when there is one", () => {
  const fromInput = documentCardsFromCalls([{
    tool: "coworker_document_create",
    status: "completed",
    input: { title: "Launch plan", summary: "Ship onboarding by Q3.", highlights: ["One", "Two", "Three", "Four"], body: "## T" },
    output: "Wrote \"Launch plan\" (id launch-plan, revision 1). Now answer with the short version.",
    metadata: {},
  }]);
  assert.deepEqual(fromInput, [{
    id: "launch-plan",
    title: "Launch plan",
    summary: "Ship onboarding by Q3.",
    highlights: ["One", "Two", "Three"],
    action: "created",
    section: "",
    revision: 1,
  }]);
  const fromResult = documentCardsFromCalls([{
    tool: "coworker_document_update",
    status: "success",
    input: { id: "launch-plan", patch: { heading: "Timeline", content: "x" } },
    output: { content: [{ type: "text", text: "Updated" }] },
    metadata: kept({ id: "launch-plan", title: "Launch plan", summary: "Refreshed.", highlights: ["A", "B"], revision: 2, action: "updated", section: "Timeline" }),
  }]);
  assert.deepEqual(fromResult, [{
    id: "launch-plan",
    title: "Launch plan",
    summary: "Refreshed.",
    highlights: ["A", "B"],
    action: "updated",
    section: "Timeline",
    revision: 2,
  }]);
  assert.equal(cardSubline(fromResult[0]!), "Updated · Timeline section");
  assert.equal(cardSubline(fromInput[0]!), "");
  assert.equal(cardSubline({ ...fromResult[0]!, section: "" }), "Updated · revision 2");
});

test("one card per document per turn: created wins over updated, later fields win, unfinished and unchanged calls do not count", () => {
  const cards = documentCardsFromCalls([
    { tool: "coworker_document_create", status: "completed", input: { title: "Launch plan", summary: "First.", highlights: ["One"] }, output: "Wrote \"Launch plan\" (id launch-plan, revision 1).", metadata: {} },
    { tool: "coworker_document_update", status: "completed", input: { id: "launch-plan", summary: "Second.", patch: { heading: "Risks", content: "x" } }, output: "Updated", metadata: {} },
    { tool: "coworker_document_update", status: "running", input: { id: "other" }, output: null, metadata: {} },
    { tool: "coworker_document_update", status: "completed", input: { id: "same", body: "x" }, output: "already says that", metadata: kept({ id: "same", title: "Same", action: "unchanged", revision: 3 }) },
    { tool: "coworker_document_read", status: "completed", input: { id: "read-only" }, output: "", metadata: {} },
  ]);
  assert.deepEqual(cards.map((card) => [card.id, card.action, card.summary, card.section]), [["launch-plan", "created", "Second.", ""]]);
  // An update with no kept title still names the document from its id.
  const bare = documentCardsFromCalls([{ tool: "coworker_document_update", status: "completed", input: { id: "old-vendor-notes", body: "x" }, output: "Updated \"Old vendor notes\" to revision 4.", metadata: {} }]);
  assert.deepEqual(bare.map((card) => [card.title, card.revision, card.action]), [["Old vendor notes", 4, "updated"]]);
});

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
  // A tiny first block (a heading, a greeting) takes the next one along.
  const heady = splitReplyLead("## Plan\n\nThe real first paragraph.\n\nMore.");
  assert.equal(heady.lead, "## Plan\n\nThe real first paragraph.");
  assert.equal(heady.rest, "More.");
  assert.deepEqual(splitReplyLead("Only one block"), { lead: "Only one block", rest: "" });
});

test("view helpers: groups by status and recency, the count dot, the in-play line, the ask-to-update prompt", () => {
  const documents = [
    { id: "a", title: "A", summary: "", highlights: [], status: "active" as const, createdAt: 1, updatedAt: 10, updatedBy: "coworker" as const, revision: 1, words: 0 },
    { id: "b", title: "B", summary: "", highlights: [], status: "active" as const, createdAt: 1, updatedAt: 30, updatedBy: "person" as const, revision: 2, words: 0 },
    { id: "c", title: "C", summary: "", highlights: [], status: "aside" as const, createdAt: 1, updatedAt: 20, updatedBy: "coworker" as const, revision: 1, words: 0 },
    { id: "d", title: "D", summary: "", highlights: [], status: "archived" as const, createdAt: 1, updatedAt: 40, updatedBy: "coworker" as const, revision: 1, words: 0 },
  ];
  const groups = groupDocuments(documents);
  assert.deepEqual(groups.active.map((document) => document.id), ["b", "a"]);
  assert.deepEqual(groups.aside.map((document) => document.id), ["c"]);
  assert.deepEqual(groups.archived.map((document) => document.id), ["d"]);
  assert.equal(documentsChangedSince(documents, 15), 2, "the coworker's changes count; the person's own edit does not");
  assert.equal(documentsChangedSince(documents, 100), 0);
  assert.equal(askToUpdatePrompt("Launch plan"), "Update \"Launch plan\" with ");
});
