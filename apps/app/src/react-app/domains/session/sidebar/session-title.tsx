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
  const controllerRef = React.useRef<ReturnType<typeof createSessionTitleMarqueeController>>(null);
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

  React.useEffect(() => {
    controllerRef.current?.setIntent(intent);
  }, [intent]);

  const nativeTooltip = resolveSessionTitleTooltip({
    overflowing: state.overflowing,
    reducedMotion,
    tooltip,
  });

  return (
    <span
      ref={viewportRef}
      className={cn(
        "min-w-0 flex-1 overflow-hidden whitespace-nowrap",
        state.moving && "ow-session-title-moving",
      )}
      data-session-title-slot
      data-session-title-moving={state.moving ? "true" : undefined}
      data-session-title-overflowing={state.overflowing ? "true" : undefined}
    >
      <span
        ref={textRef}
        aria-hidden="true"
        className="inline-block"
        data-session-title-text
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
