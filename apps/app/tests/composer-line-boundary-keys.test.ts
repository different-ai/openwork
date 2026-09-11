import { expect, test } from "bun:test";
import { lineBoundaryMoveForKey } from "../src/react-app/domains/session/surface/composer/line-boundary-keys";

function key(key: string, modifiers: Partial<Record<"shiftKey" | "metaKey" | "ctrlKey" | "altKey", boolean>> = {}) {
  return { key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...modifiers };
}

test("bare Home and End move the caret to the line boundary", () => {
  expect(lineBoundaryMoveForKey(key("Home"))).toEqual({ alter: "move", backward: true });
  expect(lineBoundaryMoveForKey(key("End"))).toEqual({ alter: "move", backward: false });
});

test("Shift+Home and Shift+End extend the selection to the line boundary", () => {
  expect(lineBoundaryMoveForKey(key("Home", { shiftKey: true }))).toEqual({ alter: "extend", backward: true });
  expect(lineBoundaryMoveForKey(key("End", { shiftKey: true }))).toEqual({ alter: "extend", backward: false });
});

test("Cmd, Ctrl and Alt chords keep the platform binding", () => {
  for (const modifier of ["metaKey", "ctrlKey", "altKey"] as const) {
    expect(lineBoundaryMoveForKey(key("Home", { [modifier]: true }))).toBeNull();
    expect(lineBoundaryMoveForKey(key("End", { [modifier]: true }))).toBeNull();
    expect(lineBoundaryMoveForKey(key("Home", { [modifier]: true, shiftKey: true }))).toBeNull();
  }
});

test("every other key is left to the editor and the transcript", () => {
  for (const other of ["PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Tab", "a", "e", " "]) {
    expect(lineBoundaryMoveForKey(key(other))).toBeNull();
    expect(lineBoundaryMoveForKey(key(other, { shiftKey: true }))).toBeNull();
  }
});
