import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_THREAD_TURNS,
  TURNS_FILE,
  beginPending,
  clearPending,
  configureTurnStore,
  dequeue,
  enqueue,
  loadThreadTurns,
  markStopped,
  parseTurnsFile,
  removeQueued,
  saveThreadTurns,
  serializeTurnsFile,
  takeQueued,
  threadTurns,
  withThreadTurns,
  type ThreadTurnState,
} from "./thread-queue.ts";

test("a missing, empty, or malformed file is simply nothing unfinished", () => {
  for (const text of [null, undefined, "", "   ", "{not json", "[]", '{"threads": 4}', '{"threads": {"ses_1": {"pending": {"prompt": "no id"}, "next": [{"id": "q", "text": "  "}]}}}']) {
    assert.deepEqual(parseTurnsFile(text), { schemaVersion: 1, threads: {} }, String(text));
  }
});

test("the file round-trips, drops threads with nothing unfinished, and tolerates missing numbers", () => {
  const state: ThreadTurnState = {
    pending: { messageId: "msg_1", prompt: "Draft the note.", startedAt: 100, stoppedAt: null },
    next: [{ id: "q_1", text: "And the summary.", queuedAt: 110 }, { id: "q_2", text: "Then email it.", queuedAt: 120 }],
  };
  const file = withThreadTurns(withThreadTurns({ schemaVersion: 1, threads: {} }, "ses_1", state), "ses_2", EMPTY_THREAD_TURNS);
  const text = serializeTurnsFile(file);
  assert.equal(text.endsWith("\n"), true);
  const parsed = parseTurnsFile(text);
  assert.deepEqual(parsed, { schemaVersion: 1, threads: { ses_1: state } });
  assert.deepEqual(threadTurns(parsed, "ses_2"), EMPTY_THREAD_TURNS);
  assert.deepEqual(
    parseTurnsFile('{"threads": {"ses_3": {"pending": {"messageId": "m", "prompt": "p"}, "next": [{"id": "q", "text": "later"}]}}}').threads.ses_3,
    { pending: { messageId: "m", prompt: "p", startedAt: 0, stoppedAt: null }, next: [{ id: "q", text: "later", queuedAt: 0 }] },
  );
});

test("Next keeps order, trims, refuses blanks and repeats, and drains one at a time", () => {
  let state = enqueue(EMPTY_THREAD_TURNS, { id: "q_1", text: "  First  ", queuedAt: 1 });
  state = enqueue(state, { id: "q_2", text: "Second", queuedAt: 2 });
  assert.equal(enqueue(state, { id: "q_2", text: "Second again", queuedAt: 3 }), state);
  assert.equal(enqueue(state, { id: "q_3", text: "   ", queuedAt: 3 }), state);
  assert.deepEqual(state.next.map((item) => item.text), ["First", "Second"]);

  const first = dequeue(state);
  assert.equal(first.message?.id, "q_1");
  assert.deepEqual(first.state.next.map((item) => item.id), ["q_2"]);
  const second = dequeue(first.state);
  assert.equal(second.message?.id, "q_2");
  assert.deepEqual(second.state.next, []);
  assert.deepEqual(dequeue(second.state), { state: second.state, message: null });
});

test("a queued message can be taken out to edit or send now, or removed; unknown ids change nothing", () => {
  const state = enqueue(enqueue(EMPTY_THREAD_TURNS, { id: "q_1", text: "First", queuedAt: 1 }), { id: "q_2", text: "Second", queuedAt: 2 });
  const taken = takeQueued(state, "q_2");
  assert.equal(taken.message?.text, "Second");
  assert.deepEqual(taken.state.next.map((item) => item.id), ["q_1"]);
  assert.deepEqual(takeQueued(state, "q_9"), { state, message: null });
  assert.deepEqual(removeQueued(state, "q_1").next.map((item) => item.id), ["q_2"]);
  assert.equal(removeQueued(state, "q_9"), state);
});

test("the pending turn is begun, stopped, and cleared without touching Next", () => {
  const queued = enqueue(EMPTY_THREAD_TURNS, { id: "q_1", text: "Later", queuedAt: 1 });
  const begun = beginPending(queued, { messageId: "msg_1", prompt: "Now", startedAt: 5 });
  assert.deepEqual(begun.pending, { messageId: "msg_1", prompt: "Now", startedAt: 5, stoppedAt: null });
  assert.equal(begun.next, queued.next);
  const stopped = markStopped(begun, 9);
  assert.equal(stopped.pending?.stoppedAt, 9);
  assert.equal(markStopped(queued, 9), queued);
  const cleared = clearPending(stopped);
  assert.equal(cleared.pending, null);
  assert.equal(cleared.next, queued.next);
  assert.equal(clearPending(cleared), cleared);
});

test("the store reads one file per coworker, caches it, serializes writes, and forgets settled threads", async () => {
  const files = new Map<string, string>();
  const writes: string[] = [];
  let reads = 0;
  configureTurnStore({
    readFile: async (slug, path) => {
      reads += 1;
      const text = files.get(`${slug}/${path}`);
      if (text === undefined) throw new Error(`ENOENT: no such file ${slug}/${path}`);
      return text;
    },
    writeFile: async (slug, path, content) => {
      writes.push(`${slug}/${path}`);
      files.set(`${slug}/${path}`, content);
    },
  });
  try {
    assert.deepEqual(await loadThreadTurns("nova", "ses_1"), EMPTY_THREAD_TURNS);
    const begun = beginPending(EMPTY_THREAD_TURNS, { messageId: "msg_1", prompt: "Draft", startedAt: 1 });
    await Promise.all([
      saveThreadTurns("nova", "ses_1", begun),
      saveThreadTurns("nova", "ses_2", enqueue(EMPTY_THREAD_TURNS, { id: "q", text: "Later", queuedAt: 2 })),
    ]);
    assert.deepEqual(writes, [`nova/${TURNS_FILE}`, `nova/${TURNS_FILE}`]);
    const onDisk = parseTurnsFile(files.get(`nova/${TURNS_FILE}`));
    assert.deepEqual(Object.keys(onDisk.threads).sort(), ["ses_1", "ses_2"]);
    assert.deepEqual(await loadThreadTurns("nova", "ses_1"), begun);
    assert.equal(reads, 1, "the file is read once per coworker");

    await saveThreadTurns("nova", "ses_1", clearPending(begun));
    assert.deepEqual(Object.keys(parseTurnsFile(files.get(`nova/${TURNS_FILE}`)).threads), ["ses_2"]);

    // Another coworker's file is its own.
    configureTurnStore({
      readFile: async (slug, path) => files.get(`${slug}/${path}`) ?? Promise.reject(new Error("ENOENT")),
      writeFile: async (slug, path, content) => { files.set(`${slug}/${path}`, content); },
    });
    assert.deepEqual(await loadThreadTurns("nova", "ses_2"), { pending: null, next: [{ id: "q", text: "Later", queuedAt: 2 }] });
    assert.deepEqual(await loadThreadTurns("scout", "ses_2"), EMPTY_THREAD_TURNS);
  } finally {
    configureTurnStore(null);
  }
});
