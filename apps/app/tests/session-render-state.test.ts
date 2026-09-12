import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import type { OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";
import { applyHistorySourceChanges, deriveRenderedSessionMessages, mergeHistoryWindow, projectHistoryRead, reconcileHistoryRead, type LatestSessionHistory } from "../src/react-app/domains/session/surface/session-render-state";
import { resolveForkBoundaryId } from "../src/react-app/domains/session/sync/transcript-reconcile";
import {
  mergeSnapshotAndLiveMessages,
  mergeSnapshotIntoCachedMessages,
} from "../src/react-app/domains/session/sync/message-merge";

function snapshotWithHistory(): OpenworkSessionSnapshot {
  const sessionId = "session-render-cycle";
  return {
    session: {
      id: sessionId,
      title: "Render-cycle history",
      time: { created: 1, updated: 2 },
      version: "0",
    },
    messages: [
      { id: "historical-user", role: "user", text: "First prompt" },
      { id: "historical-assistant", role: "assistant", text: "First answer" },
    ].map((message, index) => ({
      info: {
        id: message.id,
        role: message.role,
        sessionID: sessionId,
        time: { created: index + 1 },
      },
      parts: [{
        id: `part-${message.id}`,
        type: "text",
        text: message.text,
        sessionID: sessionId,
        messageID: message.id,
      }],
    })),
    todos: [],
    status: { type: "idle" },
  } as unknown as OpenworkSessionSnapshot;
}

function message(id: string, role: "user" | "assistant", text: string, created: number): UIMessage {
  return {
    id,
    role,
    metadata: { opencode: { created } },
    parts: [{ type: "text", text, state: "done" }],
  };
}

for (const { name, merge } of [
  {
    name: "mergeSnapshotAndLiveMessages",
    merge: (snapshot: UIMessage[], cached: UIMessage[]) =>
      mergeSnapshotAndLiveMessages(snapshot, cached, { appendLiveOnlyMessages: true }),
  },
  { name: "mergeSnapshotIntoCachedMessages", merge: mergeSnapshotIntoCachedMessages },
]) {
  describe(name, () => {
    test("keeps terminal tools by call identity without blocking fresh snapshot output", () => {
      const running = {
        id: "tools", role: "assistant", parts: [{
          type: "dynamic-tool", toolName: "bash", toolCallId: "call-a",
          state: "input-streaming", input: { command: "pwd" },
        }],
      } satisfies UIMessage;
      for (const terminal of [
        { state: "output-available", output: "finished" } as const,
        { state: "output-error", errorText: "failed" } as const,
      ]) {
        const completed: UIMessage = {
          ...running, parts: [{ ...running.parts[0], ...terminal }],
        };
        expect(merge([running], [completed])[0]).toBe(completed);
        const inputAvailable: UIMessage = {
          ...running, parts: [{ ...running.parts[0], state: "input-available" }],
        };
        expect(merge([inputAvailable], [completed])[0]).toBe(completed);
        expect(merge([completed], [running])[0]?.parts).toEqual(completed.parts);
        const reordered: UIMessage = {
          ...running, parts: [{
            type: "dynamic-tool", toolName: "bash", toolCallId: "call-b",
            state: "input-streaming", input: {},
          }, ...running.parts],
        };
        expect(merge([reordered], [completed])[0]?.parts).toEqual([
          reordered.parts[0], completed.parts[0],
        ]);
        expect(merge([running], [reordered])[0]?.parts).toEqual([
          running.parts[0], reordered.parts[0],
        ]);
        const refreshed: UIMessage = { ...completed, parts: [{
          type: "dynamic-tool", toolName: "bash", toolCallId: "call-a",
          state: "output-available", input: {}, output: "fresh snapshot output",
        }] };
        expect(merge([refreshed], [completed])[0]?.parts).toEqual(refreshed.parts);
      }
    });

    for (const historySize of [200, 400, 800]) {
      test(`bounds timestamp reads for a 140-message snapshot over ${historySize} cached messages`, () => {
        let reads = 0;
        function countedMessage(index: number, text = `answer-${index}`): UIMessage {
          return {
            ...message(`msg-${index}`, "assistant", text, index),
            metadata: { opencode: { get created() { reads += 1; return index; } } },
          };
        }
        const cached = Array.from({ length: historySize }, (_, index) => countedMessage(index));
        const snapshot = Array.from({ length: 140 }, (_, index) => countedMessage(historySize - 140 + index));
        const first = merge(snapshot, cached);
        const active = countedMessage(historySize - 1, `answer-${historySize - 1} live delta`);
        const current = [...first.slice(0, -1), active];
        reads = 0;

        const result = merge(snapshot, current);
        const timestampReads = reads;
        console.info(`${name}: history=${historySize}, snapshot=140, timestampReads=${timestampReads}`);
        expect(result.map((item) => item.id)).toEqual(cached.map((item) => item.id));
        for (let index = 0; index < historySize - 1; index += 1) {
          expect(first[index]).toBe(cached[index]);
          expect(result[index]).toBe(first[index]);
        }
        expect(result.at(-1)).toBe(active);
        expect(current.at(-1)).toBe(active);
        expect(snapshot.at(-1)?.parts).toEqual([
          { type: "text", text: `answer-${historySize - 1}`, state: "done" },
        ]);
        // A bounded snapshot must not make each missing message scan the growing history.
        expect(timestampReads).toBeLessThanOrEqual(historySize + 2 * snapshot.length);
      });
    }

    test("preserves empty-input array identity", () => {
      const messages = [message("one", "user", "one", 1)];
      expect(merge([], messages)).toBe(messages);
      expect(merge(messages, [])).toBe(messages);
    });

    test("sorts unique timestamps without losing snapshot history, live parts, or references", () => {
      const historical = message("history", "user", "old prompt", 0);
      const snapshotActive = message("active", "assistant", "short", 3);
      snapshotActive.parts.push({ type: "reasoning", text: "thinking", state: "done" });
      const liveActive = message("active", "assistant", "short plus live text", 30);
      liveActive.parts.push(
        { type: "reasoning", text: "thinking more", state: "done" },
        { type: "text", text: "extra part", state: "done" },
      );
      const middle = message("middle", "user", "next prompt", 2);
      const tail = message("tail", "assistant", "tail", 4);
      const snapshot = [snapshotActive, historical];
      const cached = [tail, liveActive, middle];
      const result = merge(snapshot, cached);

      expect(result.map((item) => item.id)).toEqual(["history", "middle", "active", "tail"]);
      expect(result[0]).toBe(historical);
      expect(result[1]).toBe(middle);
      expect(result[3]).toBe(tail);
      expect(result[2]?.metadata).toBe(snapshotActive.metadata);
      expect(result[2]?.parts).toEqual(liveActive.parts);
      expect(merge(snapshot, cached)[2]).toBe(result[2]);
      expect(snapshot).toEqual([snapshotActive, historical]);
      expect(cached).toEqual([tail, liveActive, middle]);
      expect(snapshotActive.parts[0]).toEqual({ type: "text", text: "short", state: "done" });
    });

    for (const created of [2, undefined, NaN, Infinity, -Infinity, "2"]) {
      test(`preserves source-neighbor ordering for tied or invalid timestamps (${String(created)})`, () => {
        const before = message("before", "user", "before", 2);
        const anchor = message("anchor", "assistant", "anchor", 2);
        const after = message("after", "user", "after", 2);
        for (const item of [before, anchor, after]) {
          item.metadata = { opencode: { created } };
        }

        const result = merge([anchor], [before, anchor, after]);
        expect(result.map((item) => item.id)).toEqual(["before", "anchor", "after"]);
        expect(result[0]).toBe(before);
        expect(result[1]).toBe(anchor);
        expect(result[2]).toBe(after);
      });
    }

    test("keeps timestamp insertion precedence over source neighbors when timestamps tie", () => {
      const before = message("before", "user", "before", 2);
      const anchor = message("anchor", "assistant", "anchor", 2);
      const later = message("later", "assistant", "later", 3);
      expect(merge([anchor, later], [before, anchor]).map((item) => item.id)).toEqual([
        "anchor", "before", "later",
      ]);
      expect(merge([later, anchor], [before, anchor]).map((item) => item.id)).toEqual([
        "before", "anchor", "later",
      ]);
    });

    test("does not sort mixed missing timestamps away from their source anchors", () => {
      const before = message("before", "user", "before", 1);
      delete before.metadata;
      const anchor = message("anchor", "assistant", "anchor", 2);
      const later = message("later", "assistant", "later", 3);
      const result = merge([later, anchor], [before, anchor]);
      expect(result.map((item) => item.id)).toEqual(["later", "before", "anchor"]);
      expect(result[0]).toBe(later);
      expect(result[1]).toBe(before);
      expect(result[2]).toBe(anchor);
    });
  });
}

describe("message merge duplicate and inclusion semantics", () => {
  test("only appends live-only messages when requested", () => {
    const snapshot = [message("history", "user", "history", 1)];
    const live = [message("tail", "assistant", "tail", 2)];
    expect(mergeSnapshotAndLiveMessages(snapshot, live)).toEqual(snapshot);
    expect(mergeSnapshotAndLiveMessages(snapshot, live, { appendLiveOnlyMessages: false })).toEqual(snapshot);
  });

  for (const created of [2, 3]) {
    test(`retains live duplicates but deduplicates cached-only ids (second timestamp ${created})`, () => {
      const anchor = message("anchor", "user", "anchor", 1);
      const first = message("duplicate", "assistant", "first", 2);
      const second = message("duplicate", "assistant", "second", created);
      const cached = [first, anchor, second];
      const liveResult = mergeSnapshotAndLiveMessages([anchor], cached, { appendLiveOnlyMessages: true });
      expect(liveResult.map((item) => item.id)).toEqual(["anchor", "duplicate", "duplicate"]);
      expect(liveResult[1]).toBe(first);
      expect(liveResult[2]).toBe(second);
      const cachedResult = mergeSnapshotIntoCachedMessages([anchor], cached);
      expect(cachedResult).toHaveLength(2);
      expect(cachedResult[1]).toBe(first);
    });
  }

  test("preserves each function's existing duplicate snapshot selection and last cached match", () => {
    const first = message("duplicate", "assistant", "first", 1);
    const second = message("duplicate", "assistant", "second", 2);
    const liveFirst = message("duplicate", "assistant", "short", 2);
    const liveLast = message("duplicate", "assistant", "longest live answer", 2);
    const tail = message("tail", "assistant", "tail", 3);
    const snapshot = [first, second];
    const cached = [liveFirst, liveLast, tail];
    const liveResult = mergeSnapshotAndLiveMessages(snapshot, cached, { appendLiveOnlyMessages: true });
    const cachedResult = mergeSnapshotIntoCachedMessages(snapshot, cached);
    expect(liveResult).toHaveLength(3);
    expect(cachedResult).toHaveLength(3);
    expect(liveResult[0]?.metadata).toBe(first.metadata);
    expect(liveResult[1]).toBe(liveLast);
    expect(cachedResult[0]).toBe(liveLast);
    expect(cachedResult[1]).toBe(liveLast);
    for (const result of [liveResult, cachedResult]) {
      expect(result[0]?.parts).toEqual(liveLast.parts);
      expect(result[1]?.parts).toEqual(liveLast.parts);
      expect(result[2]).toBe(tail);
    }
  });
});

describe("fork boundaries in complete history", () => {
  const history = [{ id: "z-first" }, { id: "a-answer" }, { id: "m-next" }];

  test("includes the clicked message using native history order and reserves null for the last message", () => {
    expect(resolveForkBoundaryId(history, "z-first")).toBe("a-answer");
    expect(resolveForkBoundaryId(history, "a-answer")).toBe("m-next");
    expect(resolveForkBoundaryId(history, "m-next")).toBeNull();
  });

  test("rejects missing messages rather than forking the whole conversation", () => {
    expect(() => resolveForkBoundaryId(history, "missing")).toThrow("no longer in this conversation");
    expect(() => resolveForkBoundaryId([], "missing")).toThrow("no longer in this conversation");
  });

  test("resolves display-only rows and skips synthetic error boundaries", () => {
    expect(resolveForkBoundaryId(history, "a-answer:steps")).toBe("m-next");
    expect(resolveForkBoundaryId(history, "session-error:a-answer")).toBe("m-next");
    const withError = [...history.slice(0, 2), { id: "session-error:a-answer" }, history[2]];
    expect(resolveForkBoundaryId(withError, "a-answer")).toBe("m-next");
    expect(resolveForkBoundaryId(withError, "session-error:a-answer")).toBe("m-next");
  });
});

describe("session render state", () => {
  test("preserves completed message references while the active answer advances", () => {
    const snapshot = snapshotWithHistory();
    const historicalUser = message("historical-user", "user", "First prompt", 1);
    const historicalAssistant = message("historical-assistant", "assistant", "First answer", 2);
    const activeUser = message("active-user", "user", "Second prompt", 3);
    const first = deriveRenderedSessionMessages({
      snapshot,
      transcriptState: [
        historicalUser,
        historicalAssistant,
        activeUser,
        message("active-assistant", "assistant", "chunk-1 ", 4),
      ],
    });
    const second = deriveRenderedSessionMessages({
      snapshot: snapshotWithHistory(),
      transcriptState: [
        ...first.slice(0, 3),
        message("active-assistant", "assistant", "chunk-1 chunk-2 ", 4),
      ],
    });

    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).toBe(first[2]);
    expect(second[3]).not.toBe(first[3]);
    expect(second[3]?.parts).toEqual([{ type: "text", text: "chunk-1 chunk-2 ", state: "done" }]);
  });
});

describe("warm history reconciliation", () => {
  test("newest-first native reads are projected in chronological order once per immutable messages array", () => {
    const snapshot = snapshotWithHistory();
    snapshot.messages = snapshot.messages.toReversed();
    const first = projectHistoryRead(snapshot);
    expect(first.map((message) => message.id)).toEqual(["historical-user", "historical-assistant"]);
    expect(projectHistoryRead(snapshot)).toBe(first);
    expect(projectHistoryRead({ ...snapshot, session: { ...snapshot.session, title: "Updated title" } })).toBe(first);
  });

  test("content-equivalent hydration is not a live change and field-level live changes do not revert another part", () => {
    const cached: UIMessage = { id: "active", role: "assistant", parts: [
      { type: "text", text: "old", state: "done" },
      { type: "dynamic-tool", toolName: "bash", toolCallId: "call", state: "output-available", input: {}, output: "A" },
    ] };
    const newest: UIMessage = { ...cached, parts: [cached.parts[0], {
      type: "dynamic-tool", toolName: "bash", toolCallId: "call", state: "output-available", input: {}, output: "B",
    }] };
    const hydrated: UIMessage = { ...cached, parts: cached.parts.map((part) => ({ ...part })) };
    let history: LatestSessionHistory = { messages: reconcileHistoryRead([hydrated], [newest], [cached]), source: [hydrated] };
    expect(history.messages[0].parts[1]).toMatchObject({ output: "B" });
    const streamed: UIMessage = { ...hydrated, parts: [{ type: "text", text: "longer streamed text", state: "streaming" }, hydrated.parts[1]] };
    history = applyHistorySourceChanges(history, [streamed]);
    expect(history.messages[0].parts[0]).toMatchObject({ text: "longer streamed text" });
    expect(history.messages[0].parts[1]).toMatchObject({ output: "B" });
    const corrected: UIMessage = { ...streamed, parts: [streamed.parts[0], {
      type: "dynamic-tool", toolName: "bash", toolCallId: "call", state: "output-available", input: { command: "corrected" }, output: "C",
    }] };
    history = applyHistorySourceChanges(history, [corrected]);
    expect(history.messages[0].parts[1]).toMatchObject({ input: { command: "corrected" }, output: "C" });
  });

  test("known IDs keep full-history positions and only genuinely new IDs are inserted once", () => {
    const base = ["z-first", "a-middle", "m-last"].map((id) => message(id, "user", id, 1));
    const changed = { ...base[1], parts: [{ type: "text", text: "changed" }] } satisfies UIMessage;
    const inserted = message("new", "assistant", "new", 1);
    const tail = message("tail", "assistant", "tail", 1);
    const updated = mergeHistoryWindow(base, [base[0], inserted, changed, base[2], tail, tail]);
    expect(updated.map((item) => item.id)).toEqual(["z-first", "new", "a-middle", "m-last", "tail"]);
    expect(updated[0]).toBe(base[0]);
    expect(updated[2]).toBe(changed);
    expect(updated[3]).toBe(base[2]);
    expect(mergeHistoryWindow(updated, [changed, tail])).toBe(updated);
  });

  for (const size of [200, 800, 3200]) for (const timestamps of ["tied", "missing"]) test(`newest-24 and sparse token updates stay linear over ${size} ${timestamps}-timestamp messages`, () => {
    let idReads = 0;
    let timestampReads = 0;
    let projections = 0;
    const base: UIMessage[] = Array.from({ length: size }, (_, index) => ({
      get id() { idReads += 1; return `message-${index}`; },
      role: "assistant",
      metadata: timestamps === "tied" ? { opencode: { get created() { timestampReads += 1; return 1; } } } : undefined,
      parts: [{ type: "text", text: `content-${index}`, state: "done" }],
    }));
    const tail = message("new-tail", "assistant", "persisted tail", 1);
    const newest = [...base.slice(-23), tail];
    idReads = 0;
    let history: LatestSessionHistory = { messages: reconcileHistoryRead(base, newest, base), source: base };
    expect(idReads).toBeLessThanOrEqual(size * 8 + 200);
    const fixture = snapshotWithHistory();
    const snapshot = { ...fixture, get messages() { projections += 1; return fixture.messages; } };
    let source = base;
    for (let token = 1; token <= 6; token += 1) {
      const active = message(`message-${size - 1}`, "assistant", `content-${size - 1} ${"x".repeat(token)}`, 1);
      if (timestamps === "missing") delete active.metadata;
      source = [...source.slice(0, -1), active];
      idReads = 0;
      history = applyHistorySourceChanges(history, source);
      expect(idReads).toBeLessThanOrEqual(size * 12 + 200);
      idReads = 0;
      timestampReads = 0;
      const rendered = deriveRenderedSessionMessages({ snapshot, transcriptState: source, historyComplete: true, latestHistory: history });
      expect(rendered).toBe(history.messages);
      expect(idReads).toBe(0);
      expect(timestampReads).toBe(0);
      expect(projections).toBe(0);
      expect(rendered).toHaveLength(size + 1);
      expect(rendered[0]).toBe(base[0]);
      expect(rendered[size - 2]).toBe(base[size - 2]);
      expect(rendered[size - 1].parts).toEqual(active.parts);
      expect(rendered[size]).toBe(tail);
    }
    expect(history.messages.map((item) => item.id)).toEqual([...base.map((item) => item.id), "new-tail"]);
  });
});
