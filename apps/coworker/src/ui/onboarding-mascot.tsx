import { useEffect, useRef, useState } from "react";
import type { AvatarColor, AvatarGlasses } from "@/lib/bridge";
import { CoworkerMark } from "@/ui/brand";
import { CoworkerAvatar } from "@/ui/coworker-avatar";

/**
 * The onboarding mascot: the same composition as the app icon — one white
 * coworker in front of one charcoal card — with a short welcome. Once per
 * session the front card settles into place, two visiting coworkers slide out
 * from behind it (pale mint to the upper left, pale violet to the upper right),
 * everyone blinks, and the visitors slip back behind the front card. The
 * resting state is exactly the icon. After the welcome only the front card's
 * existing subtle pointer gaze stays on. Decorative throughout: no pointer
 * events, no focus, a fixed box, one pointer listener (the front card's).
 *
 * Choreography (ms from mount): front settles 0–350 (from -1.5°, +4px);
 * pause 150; mint out 500–900 (-32px, -17px, -2° → -7°); violet out 600–1000
 * (+32px, -17px, +2° → +7°); hold to 1800 with the front blink at 1150 and the
 * visitors' at 1250/1350; mint back 1800–2200; violet back 1900–2300; gaze on
 * from 2300. If the welcome then sits untouched, one visitor may make a brief
 * solo peek before returning behind the front card. Reduced motion renders the
 * icon composition at once and keeps the visitors still.
 */

export type OnboardingMascotVariant =
  | { kind: "mark"; label?: string }
  | { kind: "coworker"; name: string; color: AvatarColor; glasses: AvatarGlasses };

export type MascotVisitor = { name: string; color: AvatarColor; glasses: AvatarGlasses };

/** The welcome's visitors: pale mint to the left, pale violet to the right, round glasses like the mark. */
export const WELCOME_VISITORS: MascotVisitor[] = [
  { name: "Mint", color: "mint", glasses: "round" },
  { name: "Violet", color: "violet", glasses: "round" },
];

const T = {
  settle: 350,
  mintOut: 500,
  violetOut: 600,
  frontBlink: 1_150,
  mintBlink: 1_250,
  violetBlink: 1_350,
  mintBack: 1_800,
  violetBack: 1_900,
  done: 2_300,
} as const;
const BLINK_MS = 240;
const AMBIENT_PEEK_MIN_MS = 9_000;
const AMBIENT_PEEK_RANGE_MS = 8_000;
const AMBIENT_BLINK_AT_MS = 620;
const AMBIENT_RETURN_AT_MS = 1_600;
const AMBIENT_HIDE_AT_MS = 2_050;

/** Welcome already played this app session, per surface; never persisted. */
const playedSessions = new Set<string>();

type Phase = "settling" | "revealing" | "holding" | "hiding" | "rest";
type VisitorSide = "left" | "right";
type AmbientPeek = { side: VisitorSide; stage: "peeking" | "returning" };

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function OnboardingMascotStack({
  variant,
  size = 96,
  sessionKey,
  visitors = variant.kind === "mark" ? WELCOME_VISITORS : [],
  reveal = "once",
  className = "",
}: {
  variant: OnboardingMascotVariant;
  /** Front card size in px; the stack's box is derived from it and never changes. */
  size?: number;
  /** Surface identity so the welcome plays once per app session even if the component remounts. */
  sessionKey: string;
  /** Coworkers behind the front card; the first visits from the upper left, the second from the upper right. */
  visitors?: MascotVisitor[];
  /** `once` reveals and hides the visitors (the welcome); `hold` reveals them and leaves them out (a team step). */
  reveal?: "once" | "hold";
  className?: string;
}) {
  const still = reducedMotion();
  const play = !still && !playedSessions.has(sessionKey) && visitors.length > 0;
  const [phase, setPhase] = useState<Phase>(() => (play ? "settling" : reveal === "hold" && !still ? "holding" : "rest"));
  const [blinks, setBlinks] = useState<{ front: boolean; left: boolean; right: boolean }>({ front: false, left: false, right: false });
  const [ambientPeek, setAmbientPeek] = useState<AmbientPeek | null>(null);
  const startedRef = useRef(false);
  const ambientActiveRef = useRef(false);

  useEffect(() => {
    if (!play || startedRef.current) return;
    // Strict Mode mounts, unmounts, and mounts again: timers are cleared in between and the
    // session is marked only when the welcome has finished, so it still plays exactly once.
    startedRef.current = true;
    const timers: number[] = [];
    const at = (ms: number, work: () => void) => timers.push(window.setTimeout(work, ms));
    const blink = (key: "front" | "left" | "right", ms: number) => {
      at(ms, () => setBlinks((current) => ({ ...current, [key]: true })));
      at(ms + BLINK_MS + 40, () => setBlinks((current) => ({ ...current, [key]: false })));
    };
    at(T.settle, () => setPhase("revealing"));
    at(T.violetOut + 400, () => setPhase("holding"));
    blink("front", T.frontBlink);
    blink("left", T.mintBlink);
    blink("right", T.violetBlink);
    if (reveal === "once") {
      at(T.mintBack, () => setPhase("hiding"));
      at(T.done, () => {
        playedSessions.add(sessionKey);
        setPhase("rest");
      });
    } else {
      at(T.done, () => playedSessions.add(sessionKey));
    }
    return () => {
      startedRef.current = false;
      for (const timer of timers) window.clearTimeout(timer);
    };
    // The welcome belongs to the mount, not to the phases it moves through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (still || phase !== "rest" || reveal !== "once" || visitors.length < 2) return;
    let idleTimer: number | undefined;
    const gestureTimers = new Set<number>();

    const later = (work: () => void, delay: number) => {
      const timer = window.setTimeout(() => {
        gestureTimers.delete(timer);
        work();
      }, delay);
      gestureTimers.add(timer);
    };
    const clearGestureTimers = () => {
      for (const timer of gestureTimers) window.clearTimeout(timer);
      gestureTimers.clear();
    };
    const dismissPeek = () => {
      clearGestureTimers();
      if (!ambientActiveRef.current) return;
      ambientActiveRef.current = false;
      setAmbientPeek(null);
      setBlinks((current) => ({ ...current, left: false, right: false }));
    };
    const schedulePeek = () => {
      if (idleTimer !== undefined) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        idleTimer = undefined;
        if (document.hidden) {
          schedulePeek();
          return;
        }

        const side: VisitorSide = Math.random() < 0.5 ? "left" : "right";
        ambientActiveRef.current = true;
        setAmbientPeek({ side, stage: "peeking" });
        later(() => setBlinks((current) => ({ ...current, [side]: true })), AMBIENT_BLINK_AT_MS);
        later(() => {
          setBlinks((current) => ({ ...current, [side]: false }));
          setAmbientPeek({ side, stage: "returning" });
        }, AMBIENT_RETURN_AT_MS);
        later(() => {
          ambientActiveRef.current = false;
          setAmbientPeek(null);
          schedulePeek();
        }, AMBIENT_HIDE_AT_MS);
      }, AMBIENT_PEEK_MIN_MS + Math.random() * AMBIENT_PEEK_RANGE_MS);
    };
    const onActivity = () => {
      if (idleTimer !== undefined) window.clearTimeout(idleTimer);
      dismissPeek();
      schedulePeek();
    };

    schedulePeek();
    window.addEventListener("pointermove", onActivity, { passive: true });
    window.addEventListener("pointerdown", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity);
    window.addEventListener("blur", dismissPeek);
    document.addEventListener("visibilitychange", onActivity);
    return () => {
      if (idleTimer !== undefined) window.clearTimeout(idleTimer);
      clearGestureTimers();
      ambientActiveRef.current = false;
      window.removeEventListener("pointermove", onActivity);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("blur", dismissPeek);
      document.removeEventListener("visibilitychange", onActivity);
    };
  }, [phase, reveal, still, visitors.length]);

  // Visitors are out while revealing or holding; they slide back while hiding and are hidden at rest.
  const visitorsOut = phase === "revealing" || phase === "holding";
  const visitorsHidden = phase === "rest" || phase === "settling";
  const gazing = phase === "rest" || phase === "holding" && reveal === "hold";
  const visitorSize = Math.round(size * 0.73);
  const width = Math.round(size * 1.9);
  const height = Math.round(size * 1.42);

  return (
    <div
      className={[
        "mascot-stack",
        `mascot-stack--${variant.kind}`,
        `is-${phase}`,
        visitorsOut ? "visitors-out" : "",
        gazing ? "is-gazing" : "",
        ambientPeek?.stage === "peeking" ? `ambient-peek-${ambientPeek.side}` : "",
        blinks.front ? "front-blinking" : "",
        blinks.left ? "left-blinking" : "",
        blinks.right ? "right-blinking" : "",
        className,
      ].filter(Boolean).join(" ")}
      style={{ width, height, ["--mascot-size" as string]: `${size}px` }}
      data-testid="onboarding-mascot"
      data-phase={phase}
      data-visitors={ambientPeek ? ambientPeek.stage : visitorsHidden ? "hidden" : visitorsOut ? "out" : "returning"}
      data-ambient-visitor={ambientPeek?.side ?? "none"}
      data-ambient-stage={ambientPeek?.stage ?? "waiting"}
    >
      <span className="mascot-stack__card" aria-hidden="true" data-testid="onboarding-mascot-card" />
      {!still
        ? visitors.slice(0, 2).map((visitor, index) => {
            const side: VisitorSide = index === 0 ? "left" : "right";
            const isAmbientVisitor = ambientPeek?.side === side;
            return (
              <div
                key={`${visitor.color}-${visitor.glasses}-${index}`}
                className={`mascot-stack__visitor mascot-stack__visitor--${side}`}
                aria-hidden="true"
                data-testid="onboarding-mascot-visitor"
                data-color={visitor.color}
                data-glasses={visitor.glasses}
                data-ambient-active={isAmbientVisitor ? "true" : "false"}
                style={visitorsHidden && !isAmbientVisitor
                  ? { visibility: "hidden" }
                  : isAmbientVisitor
                    ? { visibility: "visible", transitionDelay: "0ms" }
                    : undefined}
              >
                <CoworkerAvatar animated={false} gaze={false} color={visitor.color} glasses={visitor.glasses} name={visitor.name} size={visitorSize} />
              </div>
            );
          })
        : null}
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
