/** @jsxImportSource react */
import * as React from "react";

const POINTER_INTENT_DELAY_MS = 500;
const MARQUEE_SPEED_PX_PER_SECOND = 36;
const OVERFLOW_TOLERANCE_PX = 1;

export type SessionTitleMarqueeMetrics = {
  distance: number;
  durationMs: number;
};

export function getSessionTitleMarqueeMetrics(
  titleWidth: number,
  viewportWidth: number,
): SessionTitleMarqueeMetrics {
  const distance = Math.max(0, Math.ceil(titleWidth - viewportWidth));
  if (distance <= OVERFLOW_TOLERANCE_PX) return { distance: 0, durationMs: 0 };

  return {
    distance,
    durationMs: Math.round((distance / MARQUEE_SPEED_PX_PER_SECOND) * 1_000),
  };
}

export function shouldMoveSessionTitle(
  distance: number,
  pointerIntent: boolean,
  keyboardFocus: boolean,
  reducedMotion: boolean,
) {
  return distance > 0 && (pointerIntent || keyboardFocus) && !reducedMotion;
}

export function scheduleSessionTitlePointerIntent(activate: () => void) {
  const timer = setTimeout(activate, POINTER_INTENT_DELAY_MS);
  return () => clearTimeout(timer);
}

type SessionTitleMarqueeProps = {
  keyboardFocused: boolean;
  title: string;
  tooltip: string;
};

export function SessionTitleMarquee({ keyboardFocused, title, tooltip }: SessionTitleMarqueeProps) {
  const viewportRef = React.useRef<HTMLSpanElement>(null);
  const titleRef = React.useRef<HTMLSpanElement>(null);
  const [metrics, setMetrics] = React.useState<SessionTitleMarqueeMetrics>({ distance: 0, durationMs: 0 });
  const [pointerHover, setPointerHover] = React.useState(false);
  const [pointerIntent, setPointerIntent] = React.useState(false);
  const [reducedMotion, setReducedMotion] = React.useState(false);
  const [transitioning, setTransitioning] = React.useState(false);

  const measure = React.useCallback(() => {
    const viewport = viewportRef.current;
    const titleElement = titleRef.current;
    if (!viewport || !titleElement) return;

    const next = getSessionTitleMarqueeMetrics(titleElement.scrollWidth, viewport.clientWidth);
    setMetrics((current) => (
      current.distance === next.distance && current.durationMs === next.durationMs ? current : next
    ));
  }, []);

  React.useEffect(() => {
    const viewport = viewportRef.current;
    const titleElement = titleRef.current;
    if (!viewport || !titleElement) return;

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(titleElement);
    return () => observer.disconnect();
  }, [measure, title]);

  React.useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReducedMotion(preference.matches);
    updatePreference();
    preference.addEventListener("change", updatePreference);
    return () => preference.removeEventListener("change", updatePreference);
  }, []);

  React.useEffect(() => {
    if (!pointerHover || metrics.distance === 0 || reducedMotion) {
      setPointerIntent(false);
      return;
    }

    return scheduleSessionTitlePointerIntent(() => setPointerIntent(true));
  }, [metrics.distance, pointerHover, reducedMotion]);

  const active = shouldMoveSessionTitle(
    metrics.distance,
    pointerIntent,
    keyboardFocused,
    reducedMotion,
  );

  return (
    <span
      ref={viewportRef}
      data-session-title-viewport
      data-overflowing={metrics.distance > 0 ? "true" : undefined}
      data-moving={transitioning ? "true" : undefined}
      className="min-w-0 flex-1 overflow-hidden whitespace-nowrap"
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") setPointerHover(true);
      }}
      onPointerLeave={() => {
        setPointerHover(false);
        setPointerIntent(false);
      }}
    >
      <span
        ref={titleRef}
        data-session-title-text
        className="block w-max max-w-none"
        title={tooltip}
        style={{
          transform: `translateX(-${active ? metrics.distance : 0}px)`,
          transitionDuration: reducedMotion ? "0ms" : active ? `${metrics.durationMs}ms` : "180ms",
          transitionProperty: "transform",
          transitionTimingFunction: active ? "linear" : "ease-out",
        }}
        onTransitionRun={(event) => {
          if (event.propertyName === "transform") setTransitioning(true);
        }}
        onTransitionEnd={(event) => {
          if (event.propertyName === "transform") setTransitioning(false);
        }}
        onTransitionCancel={(event) => {
          if (event.propertyName === "transform") setTransitioning(false);
        }}
      >
        {title}
      </span>
    </span>
  );
}
