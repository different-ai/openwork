import { useEffect, useRef } from "react";

/** Keep the gaze alive without moving the avatar itself or chasing the pointer. */
export function useAvatarPointerGaze(enabled = true) {
  const avatarRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!enabled || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let animationFrame = 0;
    let pointerX = window.innerWidth / 2;
    let pointerY = window.innerHeight / 2;

    const render = () => {
      animationFrame = 0;
      const avatar = avatarRef.current;
      if (!avatar) return;
      const bounds = avatar.getBoundingClientRect();
      const deltaX = pointerX - (bounds.left + bounds.width / 2);
      const deltaY = pointerY - (bounds.top + bounds.height / 2);
      const distance = Math.hypot(deltaX, deltaY);
      const scale = Math.min(1.25, Math.max(0.4, bounds.width / 96));
      const attention = Math.min(1, distance / 120);
      const lookX = distance ? (deltaX / distance) * 1.15 * scale * attention : 0;
      const lookY = distance ? (deltaY / distance) * 0.7 * scale * attention : 0;
      avatar.style.setProperty("--avatar-look-x", `${lookX.toFixed(2)}px`);
      avatar.style.setProperty("--avatar-look-y", `${lookY.toFixed(2)}px`);
    };

    const onPointerMove = (event: PointerEvent) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (!animationFrame) animationFrame = window.requestAnimationFrame(render);
    };
    const reset = () => {
      const avatar = avatarRef.current;
      avatar?.style.setProperty("--avatar-look-x", "0px");
      avatar?.style.setProperty("--avatar-look-y", "0px");
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", reset);
    window.addEventListener("blur", reset);
    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", reset);
      window.removeEventListener("blur", reset);
    };
  }, [enabled]);

  return avatarRef;
}
