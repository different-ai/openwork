"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function reducedMotion() {
  return typeof window === "undefined" || window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export function useExampleStep(count: number, intervalMs = 2600): number | null {
  const reduced = useSyncExternalStore(subscribe, reducedMotion, () => true);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (reduced || count < 2) return;
    const timer = window.setInterval(() => setStep((current) => (current + 1) % count), intervalMs);
    return () => window.clearInterval(timer);
  }, [reduced, count, intervalMs]);

  return reduced ? null : step % Math.max(1, count);
}
