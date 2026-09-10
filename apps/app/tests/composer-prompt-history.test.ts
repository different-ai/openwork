import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { OpenworkSessionMessage, OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";
import {
  deriveComposerHistory,
  deriveRenderedSessionMessages,
  resolveRenderedSessionSnapshot,
} from "../src/react-app/domains/session/surface/session-render-state";

function message(id: string, text: string, created = 1): OpenworkSessionMessage {
  return {
    info: {
      id, sessionID: "session-a", role: "user", time: { created },
      agent: "build", model: { providerID: "test", modelID: "test" },
    },
    parts: [{ id: `part-${id}`, sessionID: "session-a", messageID: id, type: "text", text }],
  };
}

function snapshot(messages: OpenworkSessionMessage[]): OpenworkSessionSnapshot {
  return {
    session: {
      id: "session-a", slug: "history", projectID: "project-a", directory: "/fixture",
      title: "History", version: "0", time: { created: 1, updated: 100 },
    },
    messages, todos: [], status: { type: "idle" },
  };
}

function history(stored: OpenworkSessionSnapshot | null, live: UIMessage[] = []) {
  return deriveComposerHistory(deriveRenderedSessionMessages({ snapshot: stored, transcriptState: live }));
}

test("cold recall restores only user-authored text, not synthetic instructions, ignored text, files or assistant output", () => {
  const first = message("first", "  First line");
  first.parts.push(
    { id: "second-line", sessionID: "session-a", messageID: "first", type: "text", text: "Second line  " },
    { id: "synthetic", sessionID: "session-a", messageID: "first", type: "text", text: "PRIVATE INSTRUCTION", synthetic: true },
    { id: "ignored", sessionID: "session-a", messageID: "first", type: "text", text: "IGNORED TEXT", ignored: true },
    { id: "file", sessionID: "session-a", messageID: "first", type: "file", mime: "text/plain", url: "file:///private.txt" },
  );
  const hidden = message("hidden", "HIDDEN ONLY");
  hidden.parts = [{ id: "hidden-part", sessionID: "session-a", messageID: "hidden", type: "text", text: "HIDDEN ONLY", synthetic: true }];
  const stored = snapshot([first, message("blank", " \n "), hidden]);
  const before = structuredClone(stored);
  const recalled = history(stored, [{ id: "assistant", role: "assistant", parts: [{ type: "text", text: "Assistant answer" }] }]);
  expect(recalled).toEqual(["First line\nSecond line"]);
  for (const excluded of ["PRIVATE INSTRUCTION", "IGNORED TEXT", "private.txt", "HIDDEN ONLY", "Assistant answer"]) {
    expect(recalled.join("\n")).not.toContain(excluded);
  }
  expect(stored).toEqual(before);
});

test("recall caps at 50 after trimming and consecutive deduplication, retaining nonconsecutive repetitions", () => {
  const messages = Array.from({ length: 60 }, (_, index) => message(`message-${index}`, `Prompt ${index}`, index));
  messages.push(message("repeat-last", " Prompt 59 ", 60), message("repeat-earlier", "Prompt 58", 61));
  const recalled = history(snapshot(messages));
  expect(recalled).toEqual([...Array.from({ length: 49 }, (_, index) => `Prompt ${index + 11}`), "Prompt 58"]);
  expect(recalled).toHaveLength(50);
  expect(recalled).not.toContain("Prompt 10");
  expect(recalled.filter((text) => text === "Prompt 59")).toHaveLength(1);
  expect(recalled.filter((text) => text === "Prompt 58")).toHaveLength(2);
});

test("an older fetch cannot clobber a new live send and repeated snapshots do not duplicate acknowledged prompts", () => {
  const stored = snapshot([message("one", "Repeated prompt", 1), message("two", "Other prompt", 2)]);
  const live: UIMessage[] = [{ id: "three", role: "user", metadata: { opencode: { created: 3 } }, parts: [{ type: "text", text: "Repeated prompt" }] }];
  const expected = ["Repeated prompt", "Other prompt", "Repeated prompt"];
  expect(history(null, live)).toEqual(["Repeated prompt"]);
  expect(history(stored, live)).toEqual(expected);
  const acknowledged = snapshot([...stored.messages, message("three", "Repeated prompt", 3)]);
  for (let fetch = 0; fetch < 3; fetch += 1) {
    expect(history(structuredClone(acknowledged), live)).toEqual(expected);
  }
  expect(history(stored, live)).not.toEqual(["Repeated prompt", "Other prompt"]);
  expect(history(acknowledged, live)).toHaveLength(3);
  expect(stored.messages).toHaveLength(2);
  expect(live).toHaveLength(1);
});

test("switching sessions never recalls the previous session's cached snapshot", () => {
  const stored = snapshot([message("private", "Private prompt")]);
  const selected = resolveRenderedSessionSnapshot({
    sessionId: "session-b", currentSnapshot: stored,
    cachedRendered: { sessionId: "session-a", snapshot: stored },
  });
  expect(selected).toBeNull();
  expect(history(selected)).toEqual([]);
  expect(history(selected)).not.toContain("Private prompt");
  expect(history(stored)).toEqual(["Private prompt"]);
});

test("reverted messages and removed pending sends do not linger in a second history store", () => {
  const stored = snapshot([message("one", "Keep", 1), message("two", "Reverted", 2)]);
  stored.session.revert = { messageID: "two" };
  expect(history(stored)).toEqual(["Keep"]);
  expect(history(stored)).not.toContain("Reverted");
  const pending: UIMessage[] = [{ id: "pending", role: "user", parts: [{ type: "text", text: "Submitted" }] }];
  expect(deriveComposerHistory(pending)).toEqual(["Submitted"]);
  expect(deriveComposerHistory([])).toEqual([]);
  expect(deriveComposerHistory([])).not.toContain("Submitted");
});
