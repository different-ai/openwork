import assert from "node:assert/strict";
import { test } from "node:test";

import { parseFontZoomShortcut, type FontZoomShortcutAction } from "../src/app/lib/font-zoom.ts";

type ShortcutEvent = Parameters<typeof parseFontZoomShortcut>[0];

const cases: { name: string; event: Partial<ShortcutEvent>; expected: FontZoomShortcutAction | null }[] = [
  { name: "Command and the equals key zoom in", event: { metaKey: true, key: "=", code: "Equal" }, expected: "in" },
  { name: "Control and the minus key zoom out", event: { ctrlKey: true, key: "-", code: "Minus" }, expected: "out" },
  { name: "Command and zero reset zoom", event: { metaKey: true, key: "0", code: "Digit0" }, expected: "reset" },
  { name: "a layout that puts plus on another key still zooms in", event: { ctrlKey: true, key: "+", code: "BracketRight" }, expected: "in" },
  { name: "the numpad add key works without a recognized character", event: { ctrlKey: true, key: "Unidentified", code: "NumpadAdd" }, expected: "in" },
  { name: "the numpad subtract key works without a recognized character", event: { ctrlKey: true, key: "Unidentified", code: "NumpadSubtract" }, expected: "out" },
  { name: "the numpad zero key resets while it reports Insert", event: { ctrlKey: true, key: "Insert", code: "Numpad0" }, expected: "reset" },
  { name: "an unmodified numpad key is left alone", event: { key: "+", code: "NumpadAdd" }, expected: null },
  { name: "an Alt combination is left alone", event: { ctrlKey: true, altKey: true, key: "+", code: "Equal" }, expected: null },
  { name: "an unrelated Control shortcut is left alone", event: { ctrlKey: true, key: "1", code: "Digit1" }, expected: null },
];

for (const { name, event, expected } of cases) {
  test(name, () => {
    assert.equal(parseFontZoomShortcut({ key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, ...event }), expected);
  });
}
