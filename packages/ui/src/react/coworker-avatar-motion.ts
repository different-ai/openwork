"use client";

import { useEffect, useRef } from "react";

export type AvatarMotion = "quiet" | "navigation" | "attentive" | "playful" | "presentation";
export type AvatarReaction = "engage" | "wake";
/** Body cues share one attribute: intentional reactions plus the rare idle gestures the avatar picks itself. */
type BodyCue = AvatarReaction | "shake" | "perk";
type IdleGesture = "glance" | "blink" | "double-blink" | "tilt" | BodyCue;

const ENGAGE_COOLDOWN = 2_000;
const WAKE_COOLDOWN = 60_000;
const CUE_RETENTION = 1_500;
const CUE_DURATION: Record<BodyCue, number> = { engage: 640, wake: 1_000, shake: 720, perk: 820 };
/* Weighted like a real idle: mostly glances and blinks, an occasional curious tilt, and a rare shiver or perk-up. */
const IDLE_GESTURES: readonly IdleGesture[] = [
  "glance", "glance", "glance", "glance", "glance", "glance", "glance",
  "blink", "blink", "blink",
  "double-blink", "double-blink",
  "tilt", "tilt",
  "shake", "perk",
];
const RARE_GESTURE_REST = 4_000;
/* The face drifts on a longer, non-integer multiple of the float so the two layers never realign for long. */
const DRIFT_RATIO = 1.37;
const identities = new Map<string, {
  engageAt?: number;
  wakeAt?: number;
  appeared?: boolean;
  leftAt?: number;
  cue?: { reaction: AvatarReaction; at: number };
}>();
const groups = new Map<string, { at: number; owner: object }>();
const listeners = new Set<(identity: string) => void>();

function memory(identity: string) {
  let entry = identities.get(identity);
  if (!entry) {
    entry = {};
    identities.set(identity, entry);
  } else {
    identities.delete(identity);
    identities.set(identity, entry);
  }
  if (identities.size > 128) {
    const oldest = identities.keys().next().value;
    if (oldest !== undefined) identities.delete(oldest);
  }
  return entry;
}

/** Fleeting, local acknowledgement only. Call at the actual user event, not on status changes. */
export function acknowledgeCoworker(identity: string, reaction: AvatarReaction = "engage"): void {
  const entry = memory(identity);
  const now = Date.now();
  if (reaction === "wake" && entry.engageAt !== undefined && now - entry.engageAt < CUE_RETENTION) return;
  const last = reaction === "engage" ? entry.engageAt : entry.wakeAt;
  if (last !== undefined && now - last < (reaction === "engage" ? ENGAGE_COOLDOWN : WAKE_COOLDOWN)) return;
  if (reaction === "engage") entry.engageAt = now;
  else entry.wakeAt = now;
  entry.cue = { reaction, at: now };
  for (const listener of listeners) listener(identity);
}

function seedFor(identity: string) {
  let value = 2166136261;
  for (const character of identity) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return value >>> 0;
}

type PointerTarget = {
  element: SVGSVGElement;
  follow: (x: number, y: number) => void;
  leave: () => void;
};
const pointerTargets = new Set<PointerTarget>();
let pointerTarget: PointerTarget | undefined;

function leavePointer() {
  pointerTarget?.leave();
  pointerTarget = undefined;
}

function followPointer(event: PointerEvent) {
  if (event.pointerType !== "mouse" && event.pointerType !== "pen") {
    leavePointer();
    return;
  }
  let nearest: PointerTarget | undefined;
  let nearestDistance = Infinity;
  for (const target of pointerTargets) {
    const bounds = target.element.getBoundingClientRect();
    const distance = Math.hypot(event.clientX - bounds.left - bounds.width / 2, event.clientY - bounds.top - bounds.height / 2);
    if (bounds.width > 0 && distance <= Math.max(64, Math.min(150, bounds.width * 1.5)) && distance < nearestDistance) {
      nearest = target;
      nearestDistance = distance;
    }
  }
  if (pointerTarget !== nearest) leavePointer();
  pointerTarget = nearest;
  nearest?.follow(event.clientX, event.clientY);
}

function addPointerTarget(target: PointerTarget) {
  if (pointerTargets.size === 0) {
    window.addEventListener("pointermove", followPointer, { passive: true });
    document.documentElement.addEventListener("pointerleave", leavePointer);
  }
  pointerTargets.add(target);
  return () => {
    if (pointerTarget === target) leavePointer();
    pointerTargets.delete(target);
    if (pointerTargets.size === 0) {
      window.removeEventListener("pointermove", followPointer);
      document.documentElement.removeEventListener("pointerleave", leavePointer);
    }
  };
}

export type AvatarGather = { key: string; owner: object; index: number };

/** No render-time browser access, per-frame React state, or background polling. */
export function useAvatarMotion({
  identity,
  motion = "attentive",
  animated = true,
  gaze = true,
  prominent = false,
  intensity = 1,
  gather,
  regardX = 0,
  regardY = 0,
}: {
  identity: string;
  motion?: AvatarMotion;
  animated?: boolean;
  gaze?: boolean;
  prominent?: boolean;
  intensity?: number;
  gather?: AvatarGather;
  /** Resting look direction in -1..1, e.g. toward a neighbour who is replying; idle glances return to it. */
  regardX?: number;
  regardY?: number;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const seenCue = useRef<{ identity: string; at: number } | null>(null);
  const regard = useRef({ x: regardX, y: regardY });
  const retarget = useRef<() => void>(() => {});
  const groupKey = gather?.key;
  const groupOwner = gather?.owner;
  const groupIndex = gather?.index ?? 0;

  // A new regard retargets the resting pose in place; it never restarts timers, float phase or wake.
  useEffect(() => {
    regard.current = { x: regardX, y: regardY };
    retarget.current();
  }, [regardX, regardY]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const avatar = element;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    const seed = seedFor(identity);
    const timers = new Set<number>();
    let idleTimer: number | undefined;
    let gesture = 0;
    let lastGesture: IdleGesture | undefined;
    let inView = typeof IntersectionObserver === "undefined";
    let focused = document.hasFocus();
    let paused = true;
    let started = false;
    let awaySince = Date.now();
    let interacting = false;
    let reacting = false;
    let removePointer: (() => void) | undefined;

    avatar.dataset.avatarMotion = "true";
    avatar.dataset.motion = motion;
    const floatDuration = 7.6 + (seed % 2400) / 1000;
    avatar.style.setProperty("--avatar-float-duration", `${floatDuration}s`);
    avatar.style.setProperty("--avatar-drift-duration", `${(floatDuration * DRIFT_RATIO).toFixed(3)}s`);
    avatar.style.setProperty("--avatar-float-delay", `${-(seed % 7000) / 1000}s`);

    function later(work: () => void, delay: number) {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        work();
      }, delay);
      timers.add(timer);
      return timer;
    }

    function clearTimers() {
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
      idleTimer = undefined;
    }

    /** Rest: straight ahead, or toward the current regard while paused copies always rest straight. */
    function neutral() {
      const { x, y } = regard.current;
      if (!paused && (x || y)) look(x, y, "neutral");
      else {
        avatar.style.setProperty("--avatar-look-x", "0px");
        avatar.style.setProperty("--avatar-look-y", "0px");
        avatar.style.setProperty("--avatar-feature-look-x", "0px");
        avatar.style.setProperty("--avatar-feature-look-y", "0px");
        avatar.style.setProperty("--avatar-turn", "0deg");
        avatar.style.setProperty("--avatar-lean", "0deg");
        avatar.dataset.gaze = "neutral";
      }
      avatar.dataset.blinking = "false";
    }

    /** Eyes lead, features follow a little, and the whole body leans a touch toward the same side. */
    function look(x: number, y: number, source: "pointer" | "idle" | "neutral", lean = x * 1.5) {
      const strength = Math.max(0, Math.min(1, intensity));
      avatar.style.setProperty("--avatar-look-x", `${(x * 2.4 * strength).toFixed(3)}px`);
      avatar.style.setProperty("--avatar-look-y", `${(y * 2.1 * strength).toFixed(3)}px`);
      avatar.style.setProperty("--avatar-feature-look-x", `${(x * 0.35 * strength).toFixed(3)}px`);
      avatar.style.setProperty("--avatar-feature-look-y", `${(y * 0.2 * strength).toFixed(3)}px`);
      avatar.style.setProperty("--avatar-turn", `${(x * 0.65 * strength).toFixed(3)}deg`);
      avatar.style.setProperty("--avatar-lean", `${(lean * strength).toFixed(3)}deg`);
      avatar.dataset.gaze = source;
    }

    function blink(at: number) {
      later(() => { avatar.dataset.blinking = "true"; }, at);
      later(() => { avatar.dataset.blinking = "false"; }, at + 240);
    }

    function scheduleIdle() {
      if (paused || motion === "quiet" || reacting || interacting || idleTimer !== undefined) return;
      const rest = lastGesture === "shake" || lastGesture === "perk" ? RARE_GESTURE_REST : 0;
      idleTimer = later(() => {
        idleTimer = undefined;
        if (paused || interacting || reacting) return;
        const phase = seedFor(`${identity}:${gesture++}`);
        let kind = IDLE_GESTURES[phase % IDLE_GESTURES.length] ?? "glance";
        // A shiver or perk-up never plays twice in a row; the seeded sequence stays deterministic per identity.
        if ((kind === "shake" || kind === "perk") && kind === lastGesture) kind = "glance";
        lastGesture = kind;
        const side = (phase >> 4) % 2 ? 1 : -1;
        const settle = (after: number) => later(() => {
          neutral();
          scheduleIdle();
        }, after);
        switch (kind) {
          case "glance":
            look(side * 0.72, 0.18, "idle");
            blink(260);
            settle(1_100);
            break;
          case "blink":
            blink(0);
            settle(360);
            break;
          case "double-blink":
            blink(0);
            blink(360);
            settle(760);
            break;
          case "tilt":
            look(side * 0.22, -0.3, "idle", side * 2.4);
            blink(520);
            settle(1_500);
            break;
          default:
            react(kind);
        }
      }, 5_600 + rest + ((seed + gesture * 2357) % 6_400));
    }

    function react(cue: BodyCue, delay = 0) {
      if (paused) return;
      clearTimers();
      neutral();
      reacting = true;
      avatar.dataset.reaction = "none";
      const play = () => {
        avatar.dataset.reaction = cue;
        later(() => {
          reacting = false;
          avatar.dataset.reaction = "none";
          neutral();
          scheduleIdle();
        }, CUE_DURATION[cue]);
      };
      if (delay) later(play, delay);
      else play();
    }

    function receive(eventIdentity: string) {
      if (eventIdentity !== identity || paused) return;
      const cue = memory(identity).cue;
      if (!cue || Date.now() - cue.at > CUE_RETENTION) return;
      if (seenCue.current?.identity === identity && seenCue.current.at === cue.at) return;
      seenCue.current = { identity, at: cue.at };
      react(cue.reaction);
    }

    function wake(returning: boolean) {
      const now = Date.now();
      const entry = memory(identity);
      if (entry.engageAt !== undefined && now - entry.engageAt < CUE_RETENTION) return;
      if (groupKey !== undefined && groupOwner) {
        const last = groups.get(groupKey);
        if (last && now - last.at < WAKE_COOLDOWN && (last.owner !== groupOwner || now - last.at > CUE_RETENTION)) return;
        if (!last || now - last.at >= WAKE_COOLDOWN) {
          groups.delete(groupKey);
          groups.set(groupKey, { at: now, owner: groupOwner });
          if (groups.size > 64) {
            const oldest = groups.keys().next().value;
            if (oldest !== undefined) groups.delete(oldest);
          }
        }
      } else {
        if (!prominent || motion === "quiet") return;
        if (entry.appeared && !returning && (entry.leftAt === undefined || now - entry.leftAt < WAKE_COOLDOWN)) return;
      }
      entry.appeared = true;
      if (entry.wakeAt !== undefined && now - entry.wakeAt < WAKE_COOLDOWN) return;
      entry.wakeAt = now;
      react("wake", groupKey === undefined ? 0 : groupIndex * 140);
    }

    const target: PointerTarget = {
      element: avatar,
      follow: (x, y) => {
        interacting = true;
        if (reacting) return;
        clearTimers();
        avatar.dataset.blinking = "false";
        const bounds = avatar.getBoundingClientRect();
        const dx = x - bounds.left - bounds.width / 2;
        const dy = y - bounds.top - bounds.height / 2;
        const divisor = Math.max(60, Math.hypot(dx, dy));
        look(dx / divisor, dy / divisor, "pointer");
      },
      leave: () => {
        interacting = false;
        neutral();
        scheduleIdle();
      },
    };

    function sync() {
      const nextPaused = !animated || reduced.matches || document.hidden || !focused || !inView;
      avatar.dataset.motionPaused = String(nextPaused);
      if (paused !== nextPaused) {
        paused = nextPaused;
        if (paused) {
          awaySince = Date.now();
          if (prominent) memory(identity).leftAt = awaySince;
          clearTimers();
          removePointer?.();
          removePointer = undefined;
          reacting = false;
          interacting = false;
          avatar.dataset.reaction = "none";
          neutral();
        } else {
          neutral();
          receive(identity);
          if (!reacting && (!started || Date.now() - awaySince >= WAKE_COOLDOWN)) wake(started);
          if (prominent && motion !== "quiet") memory(identity).appeared = true;
          started = true;
          scheduleIdle();
        }
      }
      const trackPointer = !paused && gaze && motion !== "quiet" && finePointer.matches;
      if (trackPointer && !removePointer) removePointer = addPointerTarget(target);
      if (!trackPointer && removePointer) {
        removePointer();
        removePointer = undefined;
      }
    }

    const onBlur = () => { focused = false; sync(); };
    const onFocus = () => { focused = true; sync(); };
    const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(([entry]) => {
      inView = !!entry?.isIntersecting && entry.intersectionRatio >= 0.15;
      sync();
    }, { threshold: [0, 0.15] });
    retarget.current = () => {
      // Mid-glance or mid-reaction poses settle into the new regard on their own.
      if (paused || interacting || reacting || avatar.dataset.gaze === "idle") return;
      neutral();
    };
    neutral();
    avatar.dataset.reaction = "none";
    listeners.add(receive);
    observer?.observe(avatar);
    reduced.addEventListener("change", sync);
    finePointer.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    sync();

    return () => {
      const leftAt = paused ? awaySince : Date.now();
      retarget.current = () => {};
      paused = true;
      clearTimers();
      removePointer?.();
      neutral();
      avatar.dataset.reaction = "none";
      avatar.dataset.motionPaused = "true";
      if (prominent && started) memory(identity).leftAt = leftAt;
      listeners.delete(receive);
      observer?.disconnect();
      reduced.removeEventListener("change", sync);
      finePointer.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [identity, motion, animated, gaze, prominent, intensity, groupKey, groupOwner, groupIndex]);

  return ref;
}
