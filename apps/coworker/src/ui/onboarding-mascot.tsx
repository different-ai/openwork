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
 * from 2300. Reduced motion renders the icon composition at once.
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

/** Welcome already played this app session, per surface; never persisted. */
const playedSessions = new Set<string>();

type Phase = "settling" | "revealing" | "holding" | "hiding" | "rest";

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
  const startedRef = useRef(false);

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
        blinks.front ? "front-blinking" : "",
        blinks.left ? "left-blinking" : "",
        blinks.right ? "right-blinking" : "",
        className,
      ].filter(Boolean).join(" ")}
      style={{ width, height, ["--mascot-size" as string]: `${size}px` }}
      data-testid="onboarding-mascot"
      data-phase={phase}
      data-visitors={visitorsHidden ? "hidden" : visitorsOut ? "out" : "returning"}
    >
      <span className="mascot-stack__card" aria-hidden="true" data-testid="onboarding-mascot-card" />
      {!still
        ? visitors.slice(0, 2).map((visitor, index) => (
            <div
              key={`${visitor.color}-${visitor.glasses}-${index}`}
              className={`mascot-stack__visitor mascot-stack__visitor--${index === 0 ? "left" : "right"}`}
              aria-hidden="true"
              data-testid="onboarding-mascot-visitor"
              data-color={visitor.color}
              data-glasses={visitor.glasses}
              style={visitorsHidden ? { visibility: "hidden" } : undefined}
            >
              <CoworkerAvatar animated={false} gaze={false} color={visitor.color} glasses={visitor.glasses} name={visitor.name} size={visitorSize} />
            </div>
          ))
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
