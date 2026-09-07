"use client";

import { useEffect, useRef } from "react";

export type AvatarMotion = "quiet" | "navigation" | "attentive" | "playful" | "presentation";
export type AvatarReaction = "engage" | "wake";

const ENGAGE_COOLDOWN = 2_000;
const WAKE_COOLDOWN = 60_000;
const CUE_RETENTION = 1_500;
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
}: {
  identity: string;
  motion?: AvatarMotion;
  animated?: boolean;
  gaze?: boolean;
  prominent?: boolean;
  intensity?: number;
  gather?: AvatarGather;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const seenCue = useRef<{ identity: string; at: number } | null>(null);
  const groupKey = gather?.key;
  const groupOwner = gather?.owner;
  const groupIndex = gather?.index ?? 0;

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
    avatar.style.setProperty("--avatar-float-duration", `${7.6 + (seed % 2400) / 1000}s`);
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

    function neutral() {
      avatar.style.setProperty("--avatar-look-x", "0px");
      avatar.style.setProperty("--avatar-look-y", "0px");
      avatar.style.setProperty("--avatar-feature-look-x", "0px");
      avatar.style.setProperty("--avatar-feature-look-y", "0px");
      avatar.style.setProperty("--avatar-turn", "0deg");
      avatar.dataset.gaze = "neutral";
      avatar.dataset.blinking = "false";
    }

    function look(x: number, y: number, source: "pointer" | "idle") {
      const strength = Math.max(0, Math.min(1, intensity));
      avatar.style.setProperty("--avatar-look-x", `${(x * 2.4 * strength).toFixed(3)}px`);
      avatar.style.setProperty("--avatar-look-y", `${(y * 2.1 * strength).toFixed(3)}px`);
      avatar.style.setProperty("--avatar-feature-look-x", `${(x * 0.35 * strength).toFixed(3)}px`);
      avatar.style.setProperty("--avatar-feature-look-y", `${(y * 0.2 * strength).toFixed(3)}px`);
      avatar.style.setProperty("--avatar-turn", `${(x * 0.65 * strength).toFixed(3)}deg`);
      avatar.dataset.gaze = source;
    }

    function scheduleIdle() {
      if (paused || motion === "quiet" || reacting || interacting || idleTimer !== undefined) return;
      idleTimer = later(() => {
        idleTimer = undefined;
        if (paused || interacting || reacting) return;
        const phase = seedFor(`${identity}:${gesture++}`);
        if (phase % 3 !== 0) look(phase % 2 ? 0.72 : -0.72, 0.18, "idle");
        later(() => { avatar.dataset.blinking = "true"; }, 260);
        later(() => { avatar.dataset.blinking = "false"; }, 460);
        later(() => {
          neutral();
          scheduleIdle();
        }, 1050);
      }, 6_400 + ((seed + gesture * 2357) % 6_800));
    }

    function react(reaction: AvatarReaction, delay = 0) {
      if (paused) return;
      clearTimers();
      neutral();
      reacting = true;
      avatar.dataset.reaction = "none";
      const play = () => {
        avatar.dataset.reaction = reaction;
        later(() => {
          reacting = false;
          avatar.dataset.reaction = "none";
          scheduleIdle();
        }, reaction === "wake" ? 1000 : 640);
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
