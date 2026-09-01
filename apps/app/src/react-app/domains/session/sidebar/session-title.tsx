/** @jsxImportSource react */
import * as React from "react";

import { cn } from "@/lib/utils";
import {
  createSessionTitleMarqueeController,
  type SessionTitleIntent,
  type SessionTitleMarqueeState,
} from "./session-title-marquee";

type SessionTitleProps = {
  intent: SessionTitleIntent;
  title: string;
  tooltip: string;
};

export type SessionTitleHiddenEdges = "none" | "start" | "both" | "end";

export function resolveSessionTitleHiddenEdges({
  moving,
  overflowing,
  transitioning,
}: {
  moving: boolean;
  overflowing: boolean;
  transitioning: boolean;
}): SessionTitleHiddenEdges {
  if (!overflowing) return "none";
  if (transitioning) return "both";
  return moving ? "start" : "end";
}

const INITIAL_STATE: SessionTitleMarqueeState = {
  durationMs: 180,
  moving: false,
  offsetPx: 0,
  overflowing: false,
};

export function resolveSessionTitleTooltip({
  overflowing,
  reducedMotion,
  tooltip,
}: {
  overflowing: boolean;
  reducedMotion: boolean;
  tooltip: string;
}) {
  return overflowing && !reducedMotion ? undefined : tooltip;
}

function usePrefersReducedMotion() {
  const [reducedMotion, setReducedMotion] = React.useState(false);

  React.useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  return reducedMotion;
}

export function SessionTitle({ intent, title, tooltip }: SessionTitleProps) {
  const viewportRef = React.useRef<HTMLSpanElement>(null);
  const textRef = React.useRef<HTMLSpanElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const reducedMotionRef = React.useRef(reducedMotion);
  const [state, setState] = React.useState(INITIAL_STATE);
  const [transitioning, setTransitioning] = React.useState(false);
  const controllerRef = React.useRef<ReturnType<typeof createSessionTitleMarqueeController>>(null);
  const targetOffsetRef = React.useRef(INITIAL_STATE.offsetPx);
  reducedMotionRef.current = reducedMotion;

  React.useLayoutEffect(() => {
    const controller = createSessionTitleMarqueeController({
      getReducedMotion: () => reducedMotionRef.current,
      getText: () => textRef.current,
      getViewport: () => viewportRef.current,
      onChange: setState,
    });
    controllerRef.current = controller;
    const observer = new ResizeObserver(controller.measure);
    if (viewportRef.current) observer.observe(viewportRef.current);
    if (textRef.current) observer.observe(textRef.current);
    controller.measure();

    return () => {
      observer.disconnect();
      controller.destroy();
      controllerRef.current = null;
    };
  }, []);

  React.useLayoutEffect(() => {
    controllerRef.current?.measure();
  }, [title, reducedMotion]);

  React.useLayoutEffect(() => {
    if (targetOffsetRef.current === state.offsetPx) return;
    targetOffsetRef.current = state.offsetPx;
    setTransitioning(true);
  }, [state.offsetPx]);

  React.useEffect(() => {
    controllerRef.current?.setIntent(intent);
  }, [intent]);

  const nativeTooltip = resolveSessionTitleTooltip({
    overflowing: state.overflowing,
    reducedMotion,
    tooltip,
  });
  const hiddenEdges = resolveSessionTitleHiddenEdges({
    moving: state.moving,
    overflowing: state.overflowing,
    transitioning,
  });

  return (
    <span
      ref={viewportRef}
      className={cn(
        "min-w-0 flex-1 overflow-hidden whitespace-nowrap",
        state.moving && "ow-session-title-moving",
        hiddenEdges === "start" && "ow-session-title-hidden-start",
        hiddenEdges === "both" && "ow-session-title-hidden-both",
        hiddenEdges === "end" && "ow-session-title-hidden-end",
      )}
      data-session-title-slot
      data-session-title-hidden-edges={hiddenEdges}
      data-session-title-moving={state.moving ? "true" : undefined}
      data-session-title-overflowing={state.overflowing ? "true" : undefined}
    >
      <span
        ref={textRef}
        aria-hidden="true"
        className="inline-block"
        data-session-title-text
        onTransitionEnd={(event) => {
          if (event.propertyName === "transform") setTransitioning(false);
        }}
        title={nativeTooltip}
        style={{
          transform: `translateX(-${state.offsetPx}px)`,
          transitionDuration: `${state.durationMs}ms`,
          transitionProperty: "transform",
          transitionTimingFunction: state.moving ? "linear" : "ease-out",
        }}
      >
        {title}
      </span>
    </span>
  );
}
