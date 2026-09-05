import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { selectionIntersectsElement } from "../src/components/markdown/selection-stability";

const root = {} as Element;

function selection(input: {
  collapsed?: boolean;
  intersections: Array<boolean | Error>;
}) {
  return {
    isCollapsed: input.collapsed ?? false,
    rangeCount: input.intersections.length,
    getRangeAt(index: number) {
      const intersection = input.intersections[index];
      return {
        intersectsNode(node: Node) {
          expect(node).toBe(root);
          if (intersection instanceof Error) throw intersection;
          return intersection;
        },
      } as Range;
    },
  } as Pick<Selection, "getRangeAt" | "isCollapsed" | "rangeCount">;
}

describe("markdown selection stability", () => {
  test("recognizes a live range that intersects rendered markdown", () => {
    expect(selectionIntersectsElement(root, selection({ intersections: [false, true] }))).toBe(true);
  });

  test("does not defer updates for a collapsed caret or an empty selection", () => {
    expect(selectionIntersectsElement(root, selection({ collapsed: true, intersections: [true] }))).toBe(false);
    expect(selectionIntersectsElement(root, null)).toBe(false);
  });

  test("ignores a detached stale range and continues checking live ranges", () => {
    expect(selectionIntersectsElement(root, selection({ intersections: [new Error("detached"), true] }))).toBe(true);
  });

  test("keeps the innerHTML prop stable across unrelated completed-response renders", () => {
    const chatSource = readFileSync(join(import.meta.dir, "../src/components/markdown/markdown.tsx"), "utf8");
    const surfaceSource = readFileSync(
      join(import.meta.dir, "../src/react-app/domains/session/surface/markdown.tsx"),
      "utf8",
    );

    expect(surfaceSource).toContain("const stableInnerHtml = useMemo(() => ({ __html: html }), [html]);");
    // The chat surface memoizes the settled document payload on the committed
    // render and hands each streamed block its own cached payload object.
    expect(chatSource).toContain("const stableInnerHtml = useMemo(");
    expect(chatSource).toContain("[rendered],");
    expect(chatSource).toContain("dangerouslySetInnerHTML={block}");

    for (const source of [chatSource, surfaceSource]) {
      expect(source).toContain("dangerouslySetInnerHTML={stableInnerHtml}");
      expect(source).not.toContain("dangerouslySetInnerHTML={{ __html: html }}");
      expect(source).not.toContain("dangerouslySetInnerHTML={{ __html:");
    }
  });
});
