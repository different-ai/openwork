import assert from "node:assert/strict";
import { test } from "node:test";
import { createComposerState } from "../../../packages/workbot-ui/src/composer-state.ts";

const saved = { id: "file_example", name: "notes.txt", mediaType: "text/plain", size: 5, source: "user", createdAt: 1 } as const;
const file = () => new File(["notes"], "notes.txt", { type: "text/plain" });

test("upload completion after Send belongs to the pending message and a failed send keeps its resolved id", async () => {
  let finish: (value: typeof saved) => void = () => {};
  let progress: (loaded: number) => void = () => {};
  let uploads = 0;
  const owner = createComposerState((_file, report) => {
    uploads++;
    progress = report;
    return new Promise(resolve => { finish = resolve; });
  });
  owner.add([file()]);
  owner.setText("Read these notes");
  const id = owner.enqueue({ id: "message_1", text: owner.getSnapshot().text });
  const attempts: Array<{ id: string; attachments: string[] }> = [];
  const sender = async (entry: { id: string }, attachments: string[]) => {
    attempts.push({ id: entry.id, attachments });
    if (attempts.length === 1) throw new Error("That didn't send.");
  };
  const first = owner.send(id, sender);
  progress(3);
  assert.equal(owner.getSnapshot().uploads.length, 0);
  assert.equal(owner.getSnapshot().pending[0]?.uploads[0]?.loaded, 3);
  finish(saved);
  await first;
  assert.equal(owner.getSnapshot().pending[0]?.uploads[0]?.saved?.id, saved.id);
  assert.equal(owner.getSnapshot().pending[0]?.failed, "That didn't send.");
  await owner.send(id, sender, true);
  assert.deepEqual(attempts, [{ id, attachments: [saved.id] }, { id, attachments: [saved.id] }]);
  assert.equal(uploads, 1, "send retry never repeats a successful upload");
  assert.equal(owner.getSnapshot().pending.length, 1, "acceptance stays visible until the thread witnesses it");
  owner.acknowledge(new Set([id]));
  assert.equal(owner.getSnapshot().pending.length, 0);
  owner.dispose();
});

test("explicit retry repeats only the failed file, not successful files", async () => {
  const counts = new Map<string, number>();
  const owner = createComposerState(async file => {
    const count = (counts.get(file.name) ?? 0) + 1;
    counts.set(file.name, count);
    if (file.name === "retry.txt" && count === 1) throw new Error("Couldn't upload.");
    return { ...saved, id: file.name, name: file.name };
  });
  owner.add([file(), new File(["retry"], "retry.txt", { type: "text/plain" })]);
  const id = owner.enqueue({ id: "message_2", text: "Read both" });
  const sent: string[][] = [];
  await owner.send(id, async (_entry, ids) => { sent.push(ids); });
  assert.equal(sent.length, 0);
  assert.match(owner.getSnapshot().pending[0]?.failed ?? "", /file didn't upload/);
  await owner.send(id, async (_entry, ids) => { sent.push(ids); }, true);
  assert.deepEqual(sent, [["notes.txt", "retry.txt"]]);
  assert.equal(counts.get("notes.txt"), 1);
  assert.equal(counts.get("retry.txt"), 2);
  owner.dispose();
});

test("duplicate Send again presses do not dispatch concurrent copies", async () => {
  const owner = createComposerState(async () => saved);
  const id = owner.enqueue({ id: "message_3", text: "Hello" });
  let calls = 0;
  let finish: () => void = () => {};
  const sender = async () => { calls++; await new Promise<void>(resolve => { finish = resolve; }); };
  const first = owner.send(id, sender);
  await Promise.resolve();
  await owner.send(id, sender, true);
  assert.equal(calls, 1);
  finish();
  await first;
});

test("a correction failure retains its text, attachments, identity and an unrelated next draft", async () => {
  const owner = createComposerState(async () => saved);
  owner.setText("My next question");
  const correctionReference = { messageId: "wb_message_1", quote: "Use Monday", sentAt: 100 };
  const id = owner.enqueue({ id: "correction_1", text: "Use Friday", correctionOf: "message_1", correctionReference, attachments: [saved] });
  await owner.send(id, async () => { throw new Error("Offline"); });
  assert.equal(owner.getSnapshot().text, "My next question");
  assert.deepEqual(owner.getSnapshot().pending[0], { id, text: "Use Friday", correctionOf: "message_1", correctionReference, attachments: [saved], sentAt: owner.getSnapshot().pending[0]?.sentAt, uploads: [], failed: "Offline" });
});

test("removing a chat or identity while a file settles cannot send the discarded pending message", async () => {
  let finish: (value: typeof saved) => void = () => {};
  const owner = createComposerState(() => new Promise(resolve => { finish = resolve; }));
  owner.add([file()]);
  owner.setText("An unsent question");
  const id = owner.enqueue({ id: "message_removed", text: "Read this" });
  let calls = 0;
  const sending = owner.send(id, async () => { calls++; });
  owner.dispose();
  finish(saved);
  await sending;
  assert.equal(calls, 0);
  assert.deepEqual(owner.getSnapshot(), { text: "", uploads: [], pending: [] });
});

test("per-chat owners keep draft and upload state isolated through unsubscribing and remounting", async () => {
  const main = createComposerState(async () => saved);
  const side = createComposerState(async () => saved);
  const unsubscribe = main.subscribe(() => {});
  main.setText("Unsent main question");
  main.add([file()]);
  unsubscribe();
  side.setText("Unsent side question");
  await Promise.resolve();
  const remount = main.subscribe(() => {});
  assert.equal(main.getSnapshot().text, "Unsent main question");
  assert.equal(main.getSnapshot().uploads[0]?.saved?.id, saved.id);
  assert.equal(side.getSnapshot().text, "Unsent side question");
  assert.equal(side.getSnapshot().uploads.length, 0);
  remount(); main.dispose(); side.dispose();
});
