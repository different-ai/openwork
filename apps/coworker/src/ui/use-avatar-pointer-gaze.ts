import { useEffect, useRef } from "react";

const IDLE_MIN_DELAY_MS = 4_800;
const IDLE_DELAY_RANGE_MS = 7_200;
const IDLE_AFTER_POINTER_MS = 2_200;

/** Let the eyewear, gaze, and a tiny head turn acknowledge the pointer. */
export function useAvatarPointerGaze(enabled = true, ambient = false, intensity = 1) {
  const avatarRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!enabled || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let pointerX = window.innerWidth / 2;
    let pointerY = window.innerHeight / 2;
    let lastPointerAt = performance.now();
    let idleTimer: number | undefined;
    const gestureTimers = new Set<number>();

    const later = (work: () => void, delay: number) => {
      const timer = window.setTimeout(() => {
        gestureTimers.delete(timer);
        work();
      }, delay);
      gestureTimers.add(timer);
    };

    const resetIdlePose = () => {
      const avatar = avatarRef.current;
      if (!avatar) return;
      avatar.classList.remove("is-idle-looking", "is-idle-blinking", "is-idle-bobbing");
      avatar.style.setProperty("--avatar-idle-feature-x", "0px");
      avatar.style.setProperty("--avatar-idle-feature-y", "0px");
      avatar.style.setProperty("--avatar-idle-look-x", "0px");
      avatar.style.setProperty("--avatar-idle-look-y", "0px");
      avatar.style.setProperty("--avatar-idle-head-y", "0px");
      avatar.style.setProperty("--avatar-idle-turn", "0deg");
    };

    const clearGestureTimers = () => {
      for (const timer of gestureTimers) window.clearTimeout(timer);
      gestureTimers.clear();
    };

    const scheduleIdleGesture = () => {
      if (!ambient) return;
      if (idleTimer !== undefined) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        idleTimer = undefined;
        const avatar = avatarRef.current;
        if (!avatar || document.hidden || performance.now() - lastPointerAt < IDLE_AFTER_POINTER_MS) {
          scheduleIdleGesture();
          return;
        }

        const direction = Math.random() < 0.5 ? -1 : 1;
        avatar.style.setProperty("--avatar-idle-feature-x", `${(direction * 0.35).toFixed(2)}px`);
        avatar.style.setProperty("--avatar-idle-feature-y", "0.65px");
        avatar.style.setProperty("--avatar-idle-look-x", `${(direction * 0.55).toFixed(2)}px`);
        avatar.style.setProperty("--avatar-idle-look-y", "1.2px");
        avatar.style.setProperty("--avatar-idle-head-y", "0.25px");
        avatar.style.setProperty("--avatar-idle-turn", `${(direction * 0.35).toFixed(2)}deg`);
        avatar.classList.add("is-idle-looking");

        const blinkAt = 180 + Math.random() * 180;
        const doubleBlink = Math.random() < 0.22;
        later(() => avatar.classList.add("is-idle-blinking", "is-idle-bobbing"), blinkAt);
        if (doubleBlink) {
          later(() => avatar.classList.remove("is-idle-blinking"), blinkAt + 240);
          later(() => avatar.classList.add("is-idle-blinking"), blinkAt + 360);
        }
        later(() => {
          resetIdlePose();
          scheduleIdleGesture();
        }, 950 + Math.random() * 450);
      }, IDLE_MIN_DELAY_MS + Math.random() * IDLE_DELAY_RANGE_MS);
    };

    const render = () => {
      const avatar = avatarRef.current;
      if (!avatar) return;
      const bounds = avatar.getBoundingClientRect();
      const deltaX = pointerX - (bounds.left + bounds.width / 2);
      const deltaY = pointerY - (bounds.top + bounds.height / 2);
      const distance = Math.hypot(deltaX, deltaY);
      const scale = Math.min(1.25, Math.max(0.55, bounds.width / 96));
      const attention = Math.min(1, distance / 120);
      const directionX = distance ? deltaX / distance : 0;
      const directionY = distance ? deltaY / distance : 0;
      const featureLookX = directionX * 0.95 * scale * attention * intensity;
      const featureLookY = directionY * 1.05 * scale * attention * intensity;
      const lookX = directionX * 1.7 * scale * attention * intensity;
      const lookY = directionY * 1.3 * scale * attention * intensity;
      const headX = directionX * 0.18 * scale * attention * intensity;
      const headY = directionY * 0.42 * scale * attention * intensity;
      const turn = (directionX * 1.05 + directionY * 0.18) * attention * intensity;
      avatar.style.setProperty("--avatar-feature-look-x", `${featureLookX.toFixed(2)}px`);
      avatar.style.setProperty("--avatar-feature-look-y", `${featureLookY.toFixed(2)}px`);
      avatar.style.setProperty("--avatar-look-x", `${lookX.toFixed(2)}px`);
      avatar.style.setProperty("--avatar-look-y", `${lookY.toFixed(2)}px`);
      avatar.style.setProperty("--avatar-head-x", `${headX.toFixed(2)}px`);
      avatar.style.setProperty("--avatar-head-y", `${headY.toFixed(2)}px`);
      avatar.style.setProperty("--avatar-turn", `${turn.toFixed(3)}deg`);
    };

    // Pointer events already arrive coalesced per frame, and the work is a few style
    // properties on one element, so the gaze follows the pointer directly rather than
    // waiting for an animation frame that a hidden or busy window may not deliver.
    const onPointerMove = (event: PointerEvent) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      lastPointerAt = performance.now();
      clearGestureTimers();
      resetIdlePose();
      render();
      if (ambient && idleTimer === undefined) scheduleIdleGesture();
    };
    const reset = () => {
      const avatar = avatarRef.current;
      clearGestureTimers();
      resetIdlePose();
      avatar?.style.setProperty("--avatar-feature-look-x", "0px");
      avatar?.style.setProperty("--avatar-feature-look-y", "0px");
      avatar?.style.setProperty("--avatar-look-x", "0px");
      avatar?.style.setProperty("--avatar-look-y", "0px");
      avatar?.style.setProperty("--avatar-head-x", "0px");
      avatar?.style.setProperty("--avatar-head-y", "0px");
      avatar?.style.setProperty("--avatar-turn", "0deg");
      if (ambient && idleTimer === undefined) scheduleIdleGesture();
    };

    scheduleIdleGesture();
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", reset);
    window.addEventListener("blur", reset);
    return () => {
      if (idleTimer !== undefined) window.clearTimeout(idleTimer);
      clearGestureTimers();
      resetIdlePose();
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", reset);
      window.removeEventListener("blur", reset);
    };
  }, [ambient, enabled, intensity]);

  return avatarRef;
}
