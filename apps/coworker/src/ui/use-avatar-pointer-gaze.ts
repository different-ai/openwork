import { useEffect, useRef } from "react";

/** Let the eyewear and gaze acknowledge the pointer without moving the avatar itself. */
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
      const scale = Math.min(1.25, Math.max(0.55, bounds.width / 96));
      const attention = Math.min(1, distance / 120);
      const directionX = distance ? deltaX / distance : 0;
      const directionY = distance ? deltaY / distance : 0;
      const featureLookX = directionX * 0.72 * scale * attention;
      const featureLookY = directionY * 0.95 * scale * attention;
      const lookX = directionX * 1.6 * scale * attention;
      const lookY = directionY * 1.15 * scale * attention;
      avatar.style.setProperty("--avatar-feature-look-x", `${featureLookX.toFixed(2)}px`);
      avatar.style.setProperty("--avatar-feature-look-y", `${featureLookY.toFixed(2)}px`);
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
      avatar?.style.setProperty("--avatar-feature-look-x", "0px");
      avatar?.style.setProperty("--avatar-feature-look-y", "0px");
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
