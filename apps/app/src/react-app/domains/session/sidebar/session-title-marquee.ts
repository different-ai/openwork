export const SESSION_TITLE_HOVER_DELAY_MS = 450;
export const SESSION_TITLE_SPEED_PX_PER_SECOND = 32;

export type SessionTitleIntent = "hover" | "focus" | null;

export type SessionTitleMarqueeState = {
  durationMs: number;
  moving: boolean;
  offsetPx: number;
  overflowing: boolean;
};

type MeasurableElement = {
  clientWidth: number;
  scrollWidth: number;
};

type SessionTitleMarqueeControllerOptions = {
  getReducedMotion: () => boolean;
  getText: () => MeasurableElement | null;
  getViewport: () => MeasurableElement | null;
  onChange: (state: SessionTitleMarqueeState) => void;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

const restingState = (overflowing: boolean): SessionTitleMarqueeState => ({
  durationMs: 180,
  moving: false,
  offsetPx: 0,
  overflowing,
});

export function createSessionTitleMarqueeController({
  getReducedMotion,
  getText,
  getViewport,
  onChange,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
}: SessionTitleMarqueeControllerOptions) {
  let intent: SessionTitleIntent = null;
  let intentReady = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  const cancelTimer = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const measure = () => {
    if (destroyed) return;
    const viewport = getViewport();
    const text = getText();
    const overflowPx = viewport && text
      ? Math.max(0, text.scrollWidth - viewport.clientWidth)
      : 0;
    const overflowing = overflowPx > 1;

    if (!overflowing || !intentReady || getReducedMotion()) {
      onChange(restingState(overflowing));
      return;
    }

    onChange({
      durationMs: Math.round((overflowPx / SESSION_TITLE_SPEED_PX_PER_SECOND) * 1_000),
      moving: true,
      offsetPx: overflowPx,
      overflowing: true,
    });
  };

  const setIntent = (nextIntent: SessionTitleIntent) => {
    if (destroyed || intent === nextIntent) return;
    cancelTimer();
    intent = nextIntent;
    intentReady = nextIntent === "focus";

    if (nextIntent === "hover") {
      timer = setTimer(() => {
        timer = null;
        intentReady = true;
        measure();
      }, SESSION_TITLE_HOVER_DELAY_MS);
    }

    measure();
  };

  const destroy = () => {
    cancelTimer();
    destroyed = true;
  };

  return { destroy, measure, setIntent };
}
