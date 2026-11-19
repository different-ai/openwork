import { describe, expect, test } from "bun:test";

import {
  DIAGRAM_VIEW_RESET,
  DIAGRAM_ZOOM,
  clampDiagramScale,
  diagramTransform,
  diagramZoomPercent,
  panDiagram,
  stepDiagramZoom,
  wheelDiagramZoom,
  zoomDiagramAt,
} from "../src/components/markdown/mermaid-zoom";

describe("mermaid diagram zoom", () => {
  test("keeps the point under the pointer fixed while zooming", () => {
    const anchor = { x: 120, y: 80 };
    const view = zoomDiagramAt(DIAGRAM_VIEW_RESET, 2, anchor);
    expect(view.scale).toBe(2);
    // Content point under the anchor before: (anchor - translate) / scale.
    expect((anchor.x - view.x) / view.scale).toBe(anchor.x);
    expect((anchor.y - view.y) / view.scale).toBe(anchor.y);

    const further = zoomDiagramAt(view, 4, { x: 10, y: 20 });
    const before = { x: (10 - view.x) / view.scale, y: (20 - view.y) / view.scale };
    expect((10 - further.x) / further.scale).toBeCloseTo(before.x);
    expect((20 - further.y) / further.scale).toBeCloseTo(before.y);
  });

  test("clamps zoom between the limits and treats bad input as fitted", () => {
    expect(clampDiagramScale(100)).toBe(DIAGRAM_ZOOM.max);
    expect(clampDiagramScale(0.01)).toBe(DIAGRAM_ZOOM.min);
    expect(clampDiagramScale(Number.NaN)).toBe(1);

    let view = DIAGRAM_VIEW_RESET;
    for (let index = 0; index < 40; index += 1) view = stepDiagramZoom(view, "in", { x: 50, y: 50 });
    expect(view.scale).toBe(DIAGRAM_ZOOM.max);
    // At the limit another step is a no-op and keeps the same object.
    expect(stepDiagramZoom(view, "in", { x: 50, y: 50 })).toBe(view);
  });

  test("returning to 100% snaps back to the fitted position", () => {
    const zoomed = panDiagram(zoomDiagramAt(DIAGRAM_VIEW_RESET, 2, { x: 30, y: 40 }), 15, -25);
    expect(zoomDiagramAt(zoomed, 1, { x: 0, y: 0 })).toEqual(DIAGRAM_VIEW_RESET);
    const stepped = stepDiagramZoom(stepDiagramZoom(DIAGRAM_VIEW_RESET, "in", { x: 10, y: 10 }), "out", { x: 99, y: 99 });
    expect(stepped).toEqual(DIAGRAM_VIEW_RESET);
  });

  test("Cmd/Ctrl+scroll and pinch zoom in on negative delta and out on positive", () => {
    const anchor = { x: 0, y: 0 };
    expect(wheelDiagramZoom(DIAGRAM_VIEW_RESET, -DIAGRAM_ZOOM.wheelDeltaPerDoubling, anchor).scale).toBeCloseTo(2);
    expect(wheelDiagramZoom(DIAGRAM_VIEW_RESET, DIAGRAM_ZOOM.wheelDeltaPerDoubling, anchor).scale).toBeCloseTo(0.5);
  });

  test("pans and formats the view", () => {
    const view = panDiagram({ scale: 1.5, x: 4, y: 6 }, -10, 20);
    expect(view).toEqual({ scale: 1.5, x: -6, y: 26 });
    expect(panDiagram(view, 0, 0)).toBe(view);
    expect(diagramZoomPercent(view)).toBe("150%");
    expect(diagramTransform(view)).toBe("translate(-6px, 26px) scale(1.5)");
  });
});
