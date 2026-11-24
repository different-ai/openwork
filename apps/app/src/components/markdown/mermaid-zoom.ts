export type DiagramView = {
  scale: number;
  x: number;
  y: number;
};

export type DiagramPoint = { x: number; y: number };

export const DIAGRAM_ZOOM = {
  min: 0.5,
  max: 8,
  step: 1.25,
  wheelDeltaPerDoubling: 300,
  panStep: 48,
} as const;

export const DIAGRAM_VIEW_RESET: DiagramView = { scale: 1, x: 0, y: 0 };

export function clampDiagramScale(scale: number) {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(DIAGRAM_ZOOM.max, Math.max(DIAGRAM_ZOOM.min, scale));
}

export function zoomDiagramAt(view: DiagramView, nextScale: number, anchor: DiagramPoint): DiagramView {
  const scale = clampDiagramScale(nextScale);
  if (scale === view.scale) return view;
  if (scale === 1) return DIAGRAM_VIEW_RESET;
  const ratio = scale / view.scale;
  return {
    scale,
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio,
  };
}

export function stepDiagramZoom(view: DiagramView, direction: "in" | "out", center: DiagramPoint): DiagramView {
  const factor = direction === "in" ? DIAGRAM_ZOOM.step : 1 / DIAGRAM_ZOOM.step;
  return zoomDiagramAt(view, view.scale * factor, center);
}

export function wheelDiagramZoom(view: DiagramView, deltaY: number, anchor: DiagramPoint): DiagramView {
  const factor = 2 ** (-deltaY / DIAGRAM_ZOOM.wheelDeltaPerDoubling);
  return zoomDiagramAt(view, view.scale * factor, anchor);
}

export function panDiagram(view: DiagramView, dx: number, dy: number): DiagramView {
  if (dx === 0 && dy === 0) return view;
  return { ...view, x: view.x + dx, y: view.y + dy };
}

export function diagramZoomPercent(view: DiagramView) {
  return `${Math.round(view.scale * 100)}%`;
}

export function diagramTransform(view: DiagramView) {
  return `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}
