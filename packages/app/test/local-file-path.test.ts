import { describe, expect, test } from "bun:test";
import { normalizeLocalFilePath } from "../src/app/lib/local-file-path";

describe("normalizeLocalFilePath", () => {
  test("keeps non-file paths unchanged except trim", () => {
    expect(normalizeLocalFilePath(" notes/todo.md ")).toBe("notes/todo.md");
  });

  test("normalizes posix file uri", () => {
    expect(normalizeLocalFilePath("file:///tmp/notes.md")).toBe("/tmp/notes.md");
  });

  test("normalizes windows drive file uri", () => {
    expect(normalizeLocalFilePath("file:///C:/Users/xj/note.md")).toBe("C:/Users/xj/note.md");
  });

  test("normalizes unc file uri", () => {
    expect(normalizeLocalFilePath("file://server/share/note.md")).toBe("//server/share/note.md");
  });

  test("treats localhost file uri as local path", () => {
    expect(normalizeLocalFilePath("file://localhost/tmp/notes.md")).toBe("/tmp/notes.md");
  });

  test("handles case-insensitive file uri scheme", () => {
    expect(normalizeLocalFilePath("FILE:///tmp/notes.md")).toBe("/tmp/notes.md");
  });

  test("does not throw on malformed percent-encoded pathname", () => {
    expect(() => normalizeLocalFilePath("file:///tmp/100%/note.md")).not.toThrow();
    expect(normalizeLocalFilePath("file:///tmp/100%/note.md")).toBe("/tmp/100%/note.md");
  });

  test("does not throw on malformed percent-encoded fallback value", () => {
    expect(() => normalizeLocalFilePath("file://%zz")).not.toThrow();
    expect(normalizeLocalFilePath("file://%zz")).toBe("%zz");
  });
});
