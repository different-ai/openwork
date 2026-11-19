/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Maximize2Icon, XIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import {
  DIAGRAM_VIEW_RESET,
  DIAGRAM_ZOOM,
  diagramTransform,
  diagramZoomPercent,
  panDiagram,
  stepDiagramZoom,
  wheelDiagramZoom,
  zoomDiagramAt,
  type DiagramPoint,
  type DiagramView,
} from "./mermaid-zoom";

export type MermaidZoomDiagram = {
  key: string;
  /** Slot inside the diagram's markup that React owns; the enhancer never writes into it. */
  slot: HTMLElement;
  /** Sanitized SVG from the Mermaid renderer. */
  svg: string;
};

type Variant = "inline" | "dialog";

function frameCenter(frame: HTMLElement | null): DiagramPoint {
  if (!frame) return { x: 0, y: 0 };
  return { x: frame.clientWidth / 2, y: frame.clientHeight / 2 };
}

function pointInFrame(frame: HTMLElement, clientX: number, clientY: number): DiagramPoint {
  const rect = frame.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function ToolbarButton(props: {
  label: string;
  chord?: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [&_svg:not([class*='size-'])]:size-3.5"
            aria-label={props.label}
            aria-keyshortcuts={props.chord}
            disabled={props.disabled}
            onClick={props.onClick}
          >
            {props.children}
          </Button>
        )}
      />
      <TooltipContent>
        {props.label}
        {props.chord ? <kbd data-slot="kbd" className="font-sans opacity-70">{props.chord}</kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * One rendered Mermaid diagram that can be zoomed (buttons, +/-/0 keys,
 * Cmd/Ctrl+scroll, trackpad pinch, double-click) and panned (drag or arrow
 * keys once zoomed). Inline it keeps the page scrolling normally; in the
 * full-screen dialog plain scrolling pans.
 */
export function MermaidZoomViewport(props: {
  svg: string;
  variant: Variant;
  onOpenFullScreen?: () => void;
  frameRef?: RefObject<HTMLDivElement | null>;
}) {
  const { variant } = props;
  const localFrameRef = useRef<HTMLDivElement | null>(null);
  const frameRef = props.frameRef ?? localFrameRef;
  const [view, setView] = useState<DiagramView>(DIAGRAM_VIEW_RESET);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const svgHtml = useMemo(() => ({ __html: props.svg }), [props.svg]);
  const zoomed = view.scale !== 1 || view.x !== 0 || view.y !== 0;
  // Inline, a diagram at its fitted size lets drags and scrolls reach the page.
  const canPan = variant === "dialog" || zoomed;

  // A new rendering (theme change, edited message) starts fitted again.
  useEffect(() => {
    setView(DIAGRAM_VIEW_RESET);
  }, [props.svg]);

  // Native listener: React's wheel handler is passive and cannot stop the page zooming or scrolling.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const handleWheel = (event: WheelEvent) => {
      const zoomGesture = event.ctrlKey || event.metaKey;
      if (zoomGesture) {
        event.preventDefault();
        const anchor = pointInFrame(frame, event.clientX, event.clientY);
        setView((current) => wheelDiagramZoom(current, event.deltaY, anchor));
        return;
      }
      if (variant !== "dialog") return;
      event.preventDefault();
      setView((current) => panDiagram(current, -event.deltaX, -event.deltaY));
    };
    frame.addEventListener("wheel", handleWheel, { passive: false });
    return () => frame.removeEventListener("wheel", handleWheel);
  }, [frameRef, variant]);

  const zoomIn = () => setView((current) => stepDiagramZoom(current, "in", frameCenter(frameRef.current)));
  const zoomOut = () => setView((current) => stepDiagramZoom(current, "out", frameCenter(frameRef.current)));
  const reset = () => setView(DIAGRAM_VIEW_RESET);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.altKey) return;
    const step = DIAGRAM_ZOOM.panStep;
    const pans: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const pan = pans[event.key];
    if (pan) {
      if (!canPan) return;
      event.preventDefault();
      setView((current) => panDiagram(current, pan[0], pan[1]));
      return;
    }
    if (event.metaKey || event.ctrlKey) return;
    if (event.key === "+" || event.key === "=") zoomIn();
    else if (event.key === "-" || event.key === "_") zoomOut();
    else if (event.key === "0") reset();
    else return;
    event.preventDefault();
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!canPan || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setDragging(true);
  };
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    dragRef.current = { ...drag, x: event.clientX, y: event.clientY };
    setView((current) => panDiagram(current, dx, dy));
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  };
  const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("button")) return;
    const anchor = pointInFrame(event.currentTarget, event.clientX, event.clientY);
    const factor = event.shiftKey ? 1 / DIAGRAM_ZOOM.step : DIAGRAM_ZOOM.step ** 2;
    setView((current) => zoomDiagramAt(current, current.scale * factor, anchor));
  };

  const percent = diagramZoomPercent(view);

  return (
    <div
      ref={frameRef}
      role="group"
      aria-roledescription="zoomable diagram"
      aria-label={`Mermaid diagram, zoom ${percent}`}
      tabIndex={0}
      data-openwork-mermaid-zoom-frame=""
      data-zoomed={zoomed ? "true" : "false"}
      className={cn(
        "group/diagram relative overflow-hidden outline-none focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:ring-inset",
        variant === "dialog" ? "size-full" : "w-full rounded-b-[17px]",
        canPan && (dragging ? "cursor-grabbing touch-none select-none" : "cursor-grab touch-none"),
      )}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={handleDoubleClick}
    >
      <div
        data-openwork-mermaid-zoom-canvas=""
        className={cn(
          "origin-top-left",
          variant === "dialog"
            ? "size-full p-6 [&>svg]:size-full [&>svg]:max-w-none!"
            : "p-4 [&>svg]:mx-auto [&>svg]:h-auto [&>svg]:max-w-full",
        )}
        style={{ transform: diagramTransform(view) }}
        dangerouslySetInnerHTML={svgHtml}
      />
      <div
        role="toolbar"
        aria-label="Diagram zoom"
        className={cn(
          "absolute top-2 inset-e-2 flex items-center gap-0.5 rounded-lg border border-border bg-background p-0.5",
          variant === "inline" &&
            "opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none group-hover/diagram:opacity-100 group-focus-within/diagram:opacity-100 group-data-[zoomed=true]/diagram:opacity-100 [@media(hover:none)]:opacity-100",
        )}
      >
        <ToolbarButton label="Zoom out" chord="-" disabled={view.scale <= DIAGRAM_ZOOM.min} onClick={zoomOut}>
          <ZoomOutIcon />
        </ToolbarButton>
        <Tooltip>
          <TooltipTrigger
            render={(
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="min-w-12 rounded-md px-1.5 font-mono text-muted-foreground tabular-nums hover:bg-muted hover:text-foreground"
                aria-label={`Reset zoom, currently ${percent}`}
                aria-keyshortcuts="0"
                onClick={reset}
              >
                {percent}
              </Button>
            )}
          />
          <TooltipContent>
            Reset zoom
            <kbd data-slot="kbd" className="font-sans opacity-70">0</kbd>
          </TooltipContent>
        </Tooltip>
        <ToolbarButton label="Zoom in" chord="+" disabled={view.scale >= DIAGRAM_ZOOM.max} onClick={zoomIn}>
          <ZoomInIcon />
        </ToolbarButton>
        {props.onOpenFullScreen ? (
          <ToolbarButton label="Open full screen" onClick={props.onOpenFullScreen}>
            <Maximize2Icon />
          </ToolbarButton>
        ) : null}
      </div>
    </div>
  );
}

function MermaidZoomDiagramView(props: { svg: string }) {
  const [fullScreen, setFullScreen] = useState(false);
  const dialogFrameRef = useRef<HTMLDivElement | null>(null);

  return (
    <>
      <MermaidZoomViewport svg={props.svg} variant="inline" onOpenFullScreen={() => setFullScreen(true)} />
      <Dialog open={fullScreen} onOpenChange={setFullScreen}>
        <DialogContent
          showCloseButton={false}
          initialFocus={dialogFrameRef}
          data-openwork-mermaid-dialog=""
          className="flex h-[92dvh] flex-col gap-0 p-0 lg:h-[min(88vh,960px)] lg:w-[calc(100%-4rem)] lg:max-w-6xl lg:rounded-[24px]"
        >
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border ps-4 pe-2">
            <DialogTitle className="me-auto text-sm">Mermaid diagram</DialogTitle>
            <DialogClose
              render={<Button type="button" variant="ghost" size="icon-sm" aria-label="Close full screen" aria-keyshortcuts="Escape" />}
            >
              <XIcon />
            </DialogClose>
          </div>
          <div className="min-h-0 flex-1">
            <MermaidZoomViewport svg={props.svg} variant="dialog" frameRef={dialogFrameRef} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Mounts the interactive view into each rendered diagram's React-owned slot. */
export function MermaidZoomPortals(props: { diagrams: readonly MermaidZoomDiagram[] }) {
  return props.diagrams.map((diagram) => createPortal(<MermaidZoomDiagramView svg={diagram.svg} />, diagram.slot, diagram.key));
}
