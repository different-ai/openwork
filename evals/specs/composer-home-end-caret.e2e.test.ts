import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { emptySession } from "../worlds/desktop.ts";

const test = spec.world(emptySession);

const firstLine = "first line";
const secondLine = "second line";

test("Home and End move the caret inside a multi-line draft instead of being swallowed", async ({ user, probe, step, evidence }) => {
  // The composer caret, read from the live DOM selection as "text@offset" for
  // both ends so collapsed moves and Shift extensions are distinguishable.
  const caret = () => probe.eval(() => {
    const selection = window.getSelection();
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
    if (!selection || !editor || !selection.anchorNode || !selection.focusNode || !editor.contains(selection.anchorNode)) return null;
    const point = (node: Node, offset: number) => `${node.textContent ?? ""}@${offset}`;
    return { anchor: point(selection.anchorNode, selection.anchorOffset), focus: point(selection.focusNode, selection.focusOffset) };
  });
  // Window-level record of the last keydown so the spec can tell "the composer
  // handled this key" from "the browser default ran".
  await probe.eval(() => {
    window.addEventListener("keydown", (event) => {
      document.body.dataset.lastKeydown = JSON.stringify({ key: event.key, prevented: event.defaultPrevented });
    });
  });
  const lastKeydown = () => probe.eval(() => JSON.parse(document.body.dataset.lastKeydown ?? "null"));

  await user.type("composer", firstLine);
  await user.press("Shift+Enter");
  await user.type("composer", secondLine);
  await user.see("composer", { text: `${firstLine}\n${secondLine}` });
  expect(await caret()).toEqual({ anchor: `${secondLine}@${secondLine.length}`, focus: `${secondLine}@${secondLine.length}` });

  await step("Home and End move to the start and end of the current line", async () => {
    await user.press("Home");
    expect(await caret()).toEqual({ anchor: `${secondLine}@0`, focus: `${secondLine}@0` });
    expect(await lastKeydown()).toEqual({ key: "Home", prevented: true });
    await user.press("End");
    expect(await caret()).toEqual({ anchor: `${secondLine}@${secondLine.length}`, focus: `${secondLine}@${secondLine.length}` });
    expect(await lastKeydown()).toEqual({ key: "End", prevented: true });
  });

  await step("Shift+Home extends the selection to the line start, not the document start", async () => {
    await user.press("Shift+Home");
    expect(await caret()).toEqual({ anchor: `${secondLine}@${secondLine.length}`, focus: `${secondLine}@0` });
    await user.press("Shift+End");
    expect(await caret()).toEqual({ anchor: `${secondLine}@${secondLine.length}`, focus: `${secondLine}@${secondLine.length}` });
  });

  await step("PageUp and PageDown are left to the browser and the transcript", async () => {
    // Where the caret lands is the platform's call (macOS scrolls, Linux and
    // Windows page the caret); the composer must not claim either key.
    for (const key of ["PageUp", "PageDown"]) {
      await user.press(key);
      expect(await lastKeydown()).toEqual({ key, prevented: false });
      expect(await caret()).not.toBeNull();
    }
  });

  const draft = (await probe.composer()).draftText;
  evidence.recordAssertionEvidence(
    "navigation keys never edit the draft",
    JSON.stringify({ draft, caret: await caret() }),
    draft === `${firstLine}\n${secondLine}`,
  );
  expect(draft).toBe(`${firstLine}\n${secondLine}`);
});
