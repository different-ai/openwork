import { useEffect, useRef, useState } from "react";
import type { AvatarColor, AvatarGlasses } from "@/lib/bridge";
import { CoworkerMark } from "@/ui/brand";
import { CoworkerAvatar } from "@/ui/coworker-avatar";

/**
 * The first thing a new person sees: the Open Coworker mark in front, and a
 * couple of coworkers hiding behind it. On load the stack settles, the
 * coworkers peek out to say hello — each with its own colour and glasses —
 * blink, and slip back behind the logo. From then on they peek out whenever the
 * pointer comes near, their eyes and the logo's follow it within tiny limits,
 * and they hide again when the pointer rests or leaves. Everything is
 * decorative: no pointer events, no focus, nothing beyond the box it is given.
 *
 * Timing (ms, from mount): entrance 0–600 (rear layers first, the front card
 * 75 ms later, ease-out, no bounce); hello peek 700–2300 with one blink; gaze
 * from ~1400. Peek pose: ±0.58×size sideways, 0.16×size up, ∓8°; rest pose:
 * a 6 px sliver behind the logo. Under reduced motion everything renders
 * settled and still.
 */

export type OnboardingMascotVariant =
  | { kind: "mark"; label?: string }
  | { kind: "coworker"; name: string; color: AvatarColor; glasses: AvatarGlasses };

export type MascotPeeker = { name: string; color: AvatarColor; glasses: AvatarGlasses };

/** The default company behind the logo: distinct colours and glasses from the mark's own. */
export const DEFAULT_PEEKERS: MascotPeeker[] = [
  { name: "Scout", color: "violet", glasses: "square" },
  { name: "Nova", color: "mint", glasses: "round" },
];

const ENTRANCE_MS = 600;
const HELLO_DELAY_MS = 100;
const HELLO_MS = 1_600;
const BLINK_MS = 240;
const PEEK_IDLE_MS = 1_500;

/** Entrance already played this app session, per surface; never persisted. */
const settledSessions = new Set<string>();

type Stage = "entering" | "settled" | "gazing";

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function OnboardingMascotStack({
  variant,
  size = 96,
  sessionKey,
  peekers = variant.kind === "mark" ? DEFAULT_PEEKERS : [],
  className = "",
}: {
  variant: OnboardingMascotVariant;
  /** Front card size in px; the stack's box is derived from it and never changes. */
  size?: number;
  /** Surface identity so the entrance plays once per app session even if the component remounts. */
  sessionKey: string;
  /** Coworkers hiding behind the front card; the first peeks left, the second right. */
  peekers?: MascotPeeker[];
  className?: string;
}) {
  const still = reducedMotion();
  const replay = !settledSessions.has(sessionKey) && !still;
  const [stage, setStage] = useState<Stage>(replay ? "entering" : "gazing");
  const [peeking, setPeeking] = useState(false);
  const [blinking, setBlinking] = useState(false);
  const startedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef(0);
  const helloUntilRef = useRef(0);
  const hideAtRef = useRef(0);

  // Entrance, hello peek, blink, then gaze. Strict Mode mounts, unmounts, and mounts again: the
  // timers are cleared in between and the session is only marked once the entrance has finished,
  // so it still plays exactly once.
  useEffect(() => {
    if (!replay || startedRef.current) return;
    startedRef.current = true;
    const timers: number[] = [];
    timers.push(window.setTimeout(() => {
      settledSessions.add(sessionKey);
      setStage("settled");
    }, ENTRANCE_MS));
    timers.push(window.setTimeout(() => {
      helloUntilRef.current = Date.now() + HELLO_MS;
      setPeeking(true);
      setBlinking(true);
    }, ENTRANCE_MS + HELLO_DELAY_MS));
    timers.push(window.setTimeout(() => setBlinking(false), ENTRANCE_MS + HELLO_DELAY_MS + 420 + BLINK_MS));
    timers.push(window.setTimeout(() => setStage("gazing"), ENTRANCE_MS + HELLO_DELAY_MS + 700));
    timers.push(window.setTimeout(() => {
      helloUntilRef.current = 0;
      if (Date.now() >= hideAtRef.current) setPeeking(false);
    }, ENTRANCE_MS + HELLO_DELAY_MS + HELLO_MS));
    return () => {
      startedRef.current = false;
      for (const timer of timers) window.clearTimeout(timer);
    };
    // The sequence belongs to the mount, not to the stage it moves through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Peek while the pointer moves nearby; hide once it rests or leaves. One listener for the whole
  // stack, and state changes only on transitions, never per pointer event.
  useEffect(() => {
    if (still || peekers.length === 0) return;
    const reach = size * 1.7;
    const scheduleHide = () => {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = window.setTimeout(() => {
        if (Date.now() < helloUntilRef.current) return;
        hideAtRef.current = 0;
        setPeeking(false);
      }, PEEK_IDLE_MS);
    };
    const onPointerMove = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const bounds = root.getBoundingClientRect();
      const dx = event.clientX - (bounds.left + bounds.width / 2);
      const dy = event.clientY - (bounds.top + bounds.height / 2);
      if (Math.hypot(dx, dy) > reach) return;
      hideAtRef.current = Date.now() + PEEK_IDLE_MS;
      setPeeking((current) => {
        if (!current) setBlinkOnce();
        return true;
      });
      scheduleHide();
    };
    const blinkTimers: number[] = [];
    const setBlinkOnce = () => {
      blinkTimers.push(window.setTimeout(() => setBlinking(true), 380));
      blinkTimers.push(window.setTimeout(() => setBlinking(false), 380 + BLINK_MS + 40));
    };
    const hideNow = () => {
      if (Date.now() < helloUntilRef.current) return;
      window.clearTimeout(hideTimerRef.current);
      hideAtRef.current = 0;
      setPeeking(false);
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", hideNow);
    window.addEventListener("blur", hideNow);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", hideNow);
      window.removeEventListener("blur", hideNow);
      window.clearTimeout(hideTimerRef.current);
      for (const timer of blinkTimers) window.clearTimeout(timer);
    };
  }, [peekers.length, size, still]);

  // The box is fixed from the front size so nothing around the stack ever moves, peeking or not.
  const width = Math.round(size * 2.3);
  const height = Math.round(size * 1.5);

  return (
    <div
      ref={rootRef}
      className={[
        "mascot-stack",
        `mascot-stack--${variant.kind}`,
        stage === "entering" ? "is-entering" : "",
        stage === "gazing" ? "is-gazing" : "",
        peeking ? "is-peeking" : "",
        blinking ? "is-blinking" : "",
        className,
      ].filter(Boolean).join(" ")}
      style={{ width, height, ["--mascot-size" as string]: `${size}px` }}
      data-testid="onboarding-mascot"
      data-stage={stage}
      data-peeking={peeking ? "true" : "false"}
    >
      {peekers.slice(0, 2).map((peeker, index) => (
        <div
          key={`${peeker.color}-${peeker.glasses}-${index}`}
          className={`mascot-stack__peek mascot-stack__peek--${index === 0 ? "left" : "right"}`}
          aria-hidden="true"
          data-testid="onboarding-mascot-peek"
          data-color={peeker.color}
          data-glasses={peeker.glasses}
        >
          <CoworkerAvatar animated={false} color={peeker.color} glasses={peeker.glasses} name={peeker.name} size={Math.round(size * 0.82)} />
        </div>
      ))}
      <div className="mascot-stack__front" data-testid="onboarding-mascot-front">
        {variant.kind === "mark" ? (
          <CoworkerMark size={size} label={variant.label} tile={false} />
        ) : (
          <CoworkerAvatar animated={false} color={variant.color} glasses={variant.glasses} name={variant.name} size={size} />
        )}
      </div>
    </div>
  );
}
