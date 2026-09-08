import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LONG_REPLY_FOLD_CHARS,
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
