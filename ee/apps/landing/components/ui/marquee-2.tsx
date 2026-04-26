"use client";
import { useEffect, useMemo, useRef } from "react";
import { horizontalLoop } from "@/lib/gsap";
import { cn } from "@/lib/utils";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

interface MarqueeProps {
  speed?: number;
  repeat?: number;
  reversed?: boolean;
  className?: string;
  itemClassName?: string;
  children: React.ReactNode;
  paused?: boolean;
}

const Marquee = ({
  speed = 0.2,
  repeat = -1,
  reversed = false,
  className = "",
  itemClassName = "",
  children,
  paused = false,
}: MarqueeProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const loopRef = useRef<gsap.core.Timeline | null>(null);

  // Memoize children array to prevent unnecessary recalculations
  const childrenArray = useMemo(() => (Array.isArray(children) ? children : [children]), [children]);

  useGSAP(
    () => {
      const items = gsap.utils.toArray<HTMLElement>(".marquee-item");

      // Clean up previous animation if it exists
      if (loopRef.current) {
        loopRef.current.kill();
      }

      loopRef.current = horizontalLoop(items, {
        speed,
        repeat,
        reversed,
        paddingRight: 8,
        paused,
      });

      // Cleanup function
      return () => {
        if (loopRef.current) {
          loopRef.current.kill();
          loopRef.current = null;
        }
      };
    },
    { scope: containerRef, dependencies: [speed, repeat, reversed] },
  );

  // Reactively update pause state without recreating animation
  useEffect(() => {
    if (!loopRef.current) return;
    if (paused) {
      loopRef.current.pause();
    } else {
      loopRef.current.resume();
    }
  }, [paused]);

  return (
    <div ref={containerRef} className={cn("gap-sm py-2xs flex items-center overflow-hidden", className)}>
      {childrenArray.map((child, i) => (
        <div key={i} className={`marquee-item will-change-transform transform-3d ${itemClassName}`}>
          {child}
        </div>
      ))}
    </div>
  );
};

export default Marquee;
