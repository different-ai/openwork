"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  motion,
  useAnimationFrame,
  useMotionValue,
  useScroll,
  useSpring,
  useTransform,
  useVelocity,
} from "framer-motion";
import { cn } from "@/lib/utils";

function useReducedMotion() {
  const [prefersReduced, setPrefersReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setPrefersReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return prefersReduced;
}

interface VelocityRowProps {
  children: React.ReactNode;
  baseVelocity?: number;
  direction?: 1 | -1;
  className?: string;
}

function VelocityRow({
  children,
  baseVelocity = 5,
  direction = 1,
  className,
}: VelocityRowProps) {
  const baseX = useMotionValue(0);
  const { scrollY } = useScroll();
  const scrollVelocity = useVelocity(scrollY);
  const smoothVelocity = useSpring(scrollVelocity, {
    damping: 50,
    stiffness: 400,
  });
  const velocityFactor = useTransform(smoothVelocity, [0, 1000], [0, 5], {
    clamp: false,
  });

  const directionFactor = useRef<number>(direction);
  const prefersReduced = useReducedMotion();

  const [repetitions, setRepetitions] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (containerRef.current && textRef.current) {
      const containerWidth = containerRef.current.offsetWidth;
      const textWidth = textRef.current.offsetWidth;
      if (textWidth > 0) {
        setRepetitions(Math.ceil(containerWidth / textWidth) + 2);
      }
    }
  }, [children]);

  useAnimationFrame((_t, delta) => {
    if (prefersReduced) return;

    let moveBy =
      directionFactor.current * baseVelocity * (delta / 1000);

    // Add scroll velocity influence
    if (velocityFactor.get() < 0) {
      directionFactor.current = -direction;
    } else if (velocityFactor.get() > 0) {
      directionFactor.current = direction;
    }

    moveBy += directionFactor.current * moveBy * velocityFactor.get();

    baseX.set(baseX.get() + moveBy);

    // Wrap around
    if (textRef.current) {
      const textWidth = textRef.current.offsetWidth;
      if (textWidth > 0) {
        const mod = ((baseX.get() % textWidth) + textWidth) % textWidth;
        baseX.set(-mod);
      }
    }
  });

  return (
    <div
      ref={containerRef}
      className="overflow-hidden whitespace-nowrap"
    >
      <motion.div
        className={cn("inline-flex whitespace-nowrap", className)}
        style={{ x: baseX }}
      >
        {Array.from({ length: repetitions }).map((_, i) => (
          <span
            key={i}
            ref={i === 0 ? textRef : undefined}
            className="inline-block px-4"
          >
            {children}
          </span>
        ))}
      </motion.div>
    </div>
  );
}

interface ScrollVelocityProps {
  children: React.ReactNode;
  className?: string;
}

function ScrollVelocityContainer({
  children,
  className,
}: ScrollVelocityProps) {
  return (
    <div
      className={cn(
        "relative flex w-full flex-col items-center justify-center overflow-hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

export { ScrollVelocityContainer, VelocityRow as ScrollVelocityRow };
