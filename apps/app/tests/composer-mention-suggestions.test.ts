import { describe, expect, test } from "bun:test";
import {
  inlineMentionAtCaret, inlineMentionSuggestions, type MentionItem,
} from "../src/react-app/domains/session/surface/composer/mention-suggestions";
import type { SessionReferenceCandidate } from "../src/components/chat/session-reference";

function candidate(title: string, sessionId = "ses_report"): SessionReferenceCandidate {
  return { workspaceId: "ws_reports", workspaceTitle: "Weekly reference", updatedAt: 1, sessionId, title };
}

const notes: MentionItem = { id: "notes", kind: "file", value: "weekly-notes.txt", label: "weekly-notes.txt" };

function trigger(text: string) {
  return inlineMentionAtCaret(text, text.length);
}

describe("inline mentions", () => {
  test("uses the caret and separates the first word from the task query", () => {
    expect(trigger("compare @weekly report")).toEqual({ query: "weekly report", offset: 8, end: 22, firstWordEnd: 15 });
    expect(inlineMentionAtCaret("@weekly report for today", 14)).toEqual({ query: "weekly report", offset: 0, end: 14, firstWordEnd: 7 });
    expect(trigger("hello\n@weekly")?.offset).toBe(6);
    expect(trigger("@")?.query).toBe("");
  });

  test("does not match hashes, mid-word at signs, or across a newline", () => {
    for (const text of ["#weekly", "compare #weekly", "local@example.invalid", "@weekly\nreport", "@ weekly"]) {
      expect(trigger(text)).toBeNull();
    }
  });

  test("matches only the task title after a space and preserves first-word file matches", () => {
    const tasks = [candidate("Weekly report"), candidate("Inventory", "ses_inventory")];
    expect(inlineMentionSuggestions([notes], tasks, "weekly report").map((item) => item.kind)).toEqual(["file", "task"]);
    expect(inlineMentionSuggestions([notes], tasks, "weekly reference")).toEqual([notes]);
    expect(inlineMentionSuggestions([notes], tasks, "weekly report", "ses_report")).toEqual([notes]);
    expect(inlineMentionSuggestions([notes], tasks, "zzqxxzzq")).toEqual([]);
  });

  test("reserves four rows for each group", () => {
    const files = Array.from({ length: 8 }, (_, index) => ({ ...notes, id: `file-${index}` }));
    const tasks = Array.from({ length: 8 }, (_, index) => candidate(`Weekly report ${index}`, `ses_report${index}`));
    expect(inlineMentionSuggestions(files, tasks, "weekly report").map((item) => item.kind)).toEqual([
      "file", "file", "file", "file", "task", "task", "task", "task",
    ]);
  });
});
