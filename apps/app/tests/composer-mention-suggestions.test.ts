import { describe, expect, test } from "bun:test";
import {
  availableMentionItems, filterMentionItems, inlineMentionAtCaret, inlineMentionSuggestions, type MentionItem,
} from "../src/react-app/domains/session/surface/composer/mention-suggestions";
import type { SessionReferenceCandidate } from "../src/components/chat/session-reference";
import { COMPUTER_MENTIONS } from "../src/react-app/domains/session/surface/composer/computer-mentions";
import composerComputerMentions from "../../../packages/features/src/flags/composer-computer-mentions";

function candidate(title: string, sessionId = "ses_report"): SessionReferenceCandidate {
  return { workspaceId: "ws_reports", workspaceTitle: "Weekly reference", updatedAt: 1, sessionId, title };
}

const notes: MentionItem = { id: "notes", kind: "file", value: "weekly-notes.txt", label: "weekly-notes.txt" };

function trigger(text: string) {
  return inlineMentionAtCaret(text, text.length);
}

describe("inline mentions", () => {
  test("uses the caret to find a multi-word task query", () => {
    expect(trigger("compare @weekly report")).toEqual({ query: "weekly report", offset: 8, end: 22 });
    expect(inlineMentionAtCaret("@weekly report for today", 14)).toEqual({ query: "weekly report", offset: 0, end: 14 });
    expect(trigger("hello\n@weekly")?.offset).toBe(6);
    expect(trigger("@")?.query).toBe("");
  });

  test("does not match hashes, mid-word at signs, or across a newline", () => {
    for (const text of ["#weekly", "compare #weekly", "local@example.invalid", "@weekly\nreport", "@ weekly"]) {
      expect(trigger(text)).toBeNull();
    }
  });

  test("offers non-task items only before the first space", () => {
    const tasks = [candidate("Weekly report"), candidate("Inventory", "ses_inventory")];
    expect(inlineMentionSuggestions([notes], tasks, "weekly").map((item) => item.kind)).toEqual(["file", "task"]);
    for (const query of ["weekly report", "weekly ", "weekly\t"]) {
      expect(inlineMentionSuggestions([notes], tasks, query).map((item) => item.kind)).toEqual(["task"]);
    }
    expect(inlineMentionSuggestions([notes], tasks, "weekly-notes.txt please summarise")).toEqual([]);
    expect(inlineMentionSuggestions([notes], tasks, "weekly reference")).toEqual([]);
    expect(inlineMentionSuggestions([notes], tasks, "weekly report", "ses_report")).toEqual([]);
    expect(inlineMentionSuggestions([notes], tasks, "zzqxxzzq")).toEqual([]);
  });

  test("hides run targets by default without hiding files, agents, or task references", () => {
    const agent: MentionItem = { id: "agent:review", kind: "agent", value: "review", label: "review" };
    const items = [...COMPUTER_MENTIONS, notes, agent];
    expect(composerComputerMentions.default).toBe(false);
    const available = availableMentionItems(items, composerComputerMentions.default);
    expect(filterMentionItems(available, "")).toEqual([notes, agent]);
    expect(inlineMentionSuggestions(available, [candidate("Weekly report")], "").map((item) => item.kind)).toEqual(["file", "agent", "task"]);
    for (const query of ["cloud", "desktop"]) {
      expect(filterMentionItems(available, query)).toEqual([]);
      expect(inlineMentionSuggestions(available, [], query)).toEqual([]);
    }
    expect(availableMentionItems(items, true)).toEqual(items);
  });

  test("reserves four rows for each group", () => {
    const files = Array.from({ length: 8 }, (_, index) => ({ ...notes, id: `file-${index}` }));
    const tasks = Array.from({ length: 8 }, (_, index) => candidate(`Weekly report ${index}`, `ses_report${index}`));
    expect(inlineMentionSuggestions(files, tasks, "weekly").map((item) => item.kind)).toEqual([
      "file", "file", "file", "file", "task", "task", "task", "task",
    ]);
  });
});
