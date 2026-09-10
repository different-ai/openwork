/** @jsxImportSource react */
import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { UIMessage } from "ai";
import type { ComposerAttachment } from "../src/app/types";
import { pendingMessageParts, useDisplayedMessages } from "../src/react-app/domains/session/surface/use-displayed-messages";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function fixture() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let output: UIMessage[] = [];
  let input: Parameters<typeof useDisplayedMessages>[0] = {
    messages: [{ id: "history", role: "assistant", parts: [{ type: "text", text: "Answer" }] }],
    extraMessages: [], sessionId: "session", autoSending: false,
    composer: { draft: "", attachments: [], pasteParts: [] },
  };
  function Harness() {
    output = useDisplayedMessages(input);
    return <div>{output.length}</div>;
  }
  cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
  return {
    get input() { return input; },
    async render(update: Partial<typeof input> = {}) {
      input = { ...input, ...update };
      await act(async () => root.render(<Harness />));
      return output;
    },
  };
}

function attachment(): ComposerAttachment {
  return {
    id: "file", kind: "file", name: "notes.txt", mimeType: "text/plain", size: 5,
    file: new File(["notes"], "notes.txt", { type: "text/plain" }), previewUrl: "blob:notes",
  };
}

test("typing, attachment and paste edits retain the displayed transcript identity, including appended eval messages", async () => {
  const view = fixture();
  for (const extraMessages of [[], [{ id: "eval", role: "assistant", parts: [{ type: "text", text: "Example" }] }]] satisfies UIMessage[][]) {
    const initial = await view.render({ extraMessages });
    if (!extraMessages.length) expect(initial).toBe(view.input.messages);
    for (const draft of ["H", "He", "Hello", ""]) {
      expect(await view.render({ composer: { ...view.input.composer, draft } })).toBe(initial);
    }
    expect(await view.render({ composer: { ...view.input.composer, attachments: [attachment()] } })).toBe(initial);
    expect(await view.render({ composer: { ...view.input.composer, pasteParts: [{ id: "paste", label: "Pasted text #1", text: "Full pasted text", lines: 1 }] } })).toBe(initial);
    expect(await view.render({ composer: { draft: "", attachments: [], pasteParts: [] } })).toBe(initial);
    expect(initial[0]).toBe(view.input.messages[0]);
  }
});

test("autosend previews track their selected composer, and captured sends ignore the next draft", async () => {
  const view = fixture();
  const history = await view.render();
  expect(await view.render({ autoSending: true })).toBe(history);
  const first = await view.render({ composer: { draft: "First", attachments: [], pasteParts: [] } });
  expect(first.map((message) => message.id)).toEqual(["history", "session:first-send"]);
  expect(first[1].parts).toEqual([{ type: "text", text: "First" }]);
  const updated = await view.render({ composer: { ...view.input.composer, draft: "First updated", attachments: [attachment()] } });
  expect(updated).not.toBe(first);
  expect(updated[1].parts).toEqual([{ type: "text", text: "First updated" }, {
    type: "file", filename: "notes.txt", mediaType: "text/plain", url: "blob:notes",
  }]);
  const pasted = await view.render({ composer: {
    draft: "[pasted text note]", attachments: [],
    pasteParts: [{ id: "paste", label: "note", text: "Full pasted text", lines: 1 }],
  } });
  expect(pasted[1].parts).toEqual([{ type: "text", text: "Full pasted text" }]);
  const revisedPaste = await view.render({ composer: {
    ...view.input.composer, pasteParts: [{ id: "paste", label: "note", text: "Revised paste", lines: 1 }],
  } });
  expect(revisedPaste[1].parts).toEqual([{ type: "text", text: "Revised paste" }]);
  const captured = await view.render({ autoSendComposer: view.input.composer });
  expect(await view.render({ composer: { draft: "Next draft", attachments: [], pasteParts: [] } })).toBe(captured);
  const otherSession = await view.render({ sessionId: "other" });
  expect(otherSession[1].id).toBe("other:first-send");
  expect(await view.render({ autoSending: false })).toBe(history);
});

test("live transcript and extra-message changes invalidate displayed output without mutating history", async () => {
  const view = fixture();
  const initial = await view.render();
  const messages: UIMessage[] = [{ ...initial[0], parts: [{ type: "text", text: "Answer continues" }] }];
  expect(await view.render({ messages })).toBe(messages);
  const extra: UIMessage = { id: "eval", role: "assistant", parts: [{ type: "text", text: "Example" }] };
  expect(await view.render({ extraMessages: [extra] })).toEqual([...messages, extra]);
  expect(initial[0].parts).toEqual([{ type: "text", text: "Answer" }]);
});

test("pending attachment reconciliation still preserves usable server files", () => {
  const serverParts: UIMessage["parts"] = [{ type: "file", filename: "notes.txt", mediaType: "text/plain", url: "file:///notes.txt" }];
  expect(pendingMessageParts("Prompt", [attachment()], serverParts)).toEqual({
    parts: [{ type: "text", text: "Prompt" }, ...serverParts], attachmentsReady: true,
  });
  expect(serverParts).toHaveLength(1);
});
