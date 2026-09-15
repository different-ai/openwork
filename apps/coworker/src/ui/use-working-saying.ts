import { useEffect, useState } from "react";
import { workingSaying, type Personality } from "@/lib/personalities";

const ROTATE_EVERY_MS = 7_000;

/**
 * The saying to show while `active`. Rotates on a fixed cadence from a
 * deterministic order seeded by the coworker and the piece of work, so the
 * rail, the thread, and the Now card all agree. Returns "" when the
 * personality is `none`, when idle, or under reduced motion (a static first
 * saying is still fine there, so only the rotation stops).
 */
export function useWorkingSaying(personality: Personality, seed: string, active: boolean): string {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setTick(0);
    if (!active || personality === "none") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setTick((current) => current + 1), ROTATE_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [active, personality, seed]);

  if (!active) return "";
  return workingSaying(personality, seed, tick);
}
