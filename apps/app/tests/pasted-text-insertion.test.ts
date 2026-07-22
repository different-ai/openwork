import { describe, expect, mock, test } from "bun:test";
import { splitPastedText } from "../src/react-app/domains/session/surface/composer/pasted-text";

type FakeNodeKind = "line-break" | "tab" | "text";

type FakeNode = {
  kind: FakeNodeKind;
  setStyle: (style: string) => void;
  style: string;
  text: string;
};

type FakeSelection = {
  insertNodes: (nodes: FakeNode[]) => void;
  kind: "range";
  setStyle: (style: string) => void;
  style: string;
};

describe("pasted-text insertion", () => {
  test("plans pasted text nodes while preserving newlines and tabs", () => {
    expect(splitPastedText("first\nsecond\tthird")).toEqual([
      { kind: "text", text: "first" },
      { kind: "line-break" },
      { kind: "text", text: "second" },
      { kind: "tab" },
      { kind: "text", text: "third" },
    ]);
  });

  test("expands pasted text as plain text and clears selection style", async () => {
    const insertedNodes: FakeNode[] = [];
    const selection: FakeSelection = {
      insertNodes(nodes) {
        insertedNodes.push(...nodes);
      },
      kind: "range",
      setStyle(style) {
        this.style = style;
      },
      style: "stale-style",
    };

    function createNode(kind: FakeNodeKind, text = ""): FakeNode {
      return {
        kind,
        setStyle(style) {
          this.style = style;
        },
        style: "",
        text,
      };
    }

    mock.module("lexical", () => ({
      $createLineBreakNode: () => createNode("line-break"),
      $createTabNode: () => createNode("tab"),
      $createTextNode: (text: string) => createNode("text", text),
      $getSelection: () => selection,
      $isRangeSelection: (value: unknown) => value === selection,
    }));

    const { insertPastedText } = await import("../src/react-app/domains/session/surface/composer/pasted-text-insertion");

    expect(insertPastedText("first\nsecond")).toBe(true);
    expect(insertedNodes.map((node) => ({ kind: node.kind, style: node.style, text: node.text }))).toEqual([
      { kind: "text", style: "", text: "first" },
      { kind: "line-break", style: "", text: "" },
      { kind: "text", style: "", text: "second" },
    ]);
    expect(selection.style).toBe("");
  });
});
