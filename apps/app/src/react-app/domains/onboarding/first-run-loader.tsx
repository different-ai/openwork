/** @jsxImportSource react */
import { useEffect, useState, useSyncExternalStore } from "react";
import { Loader2 } from "lucide-react";
import { PaperGrainGradient } from "@openwork/ui/react";

import { getResolvedThemeMode, subscribeToTheme } from "../../../app/theme";

const MESSAGES = [
  "Warming things up…",
  "Working the magic…",
  "Talking to the gremlins…",
  "Setting up your workspace…",
  "Sharpening the pencils…",
  "Untangling the wires…",
  "Teaching the agent some manners…",
  "Almost there…",
];

// Silver-gray grain palette matching the landing page hero, per theme.
const GRAIN = {
  light: { back: "#f4f5f7", colors: ["#c8cdd4", "#9aa1ab", "#e9ebee", "#767d87"] },
  dark: { back: "#0e0f11", colors: ["#2a2d33", "#42464e", "#191b1f", "#565b64"] },
} as const;

/**
 * Full-screen loader shown on a brand-new install while the first session is
 * being created, so the "select or create a session" page never flashes.
 */
export function FirstRunLoader() {
  const theme = useSyncExternalStore(subscribeToTheme, getResolvedThemeMode);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setIndex((current) => (current + 1) % MESSAGES.length);
    }, 1800);
    return () => window.clearInterval(interval);
  }, []);

  const grain = GRAIN[theme];
  return (
    <div className="fixed inset-0 z-50">
      <PaperGrainGradient
        speed={0.6}
        softness={0.7}
        intensity={0.4}
        noise={0.35}
        shape="corners"
        colors={[...grain.colors]}
        colorBack="#00000000"
        style={{ backgroundColor: grain.back, width: "100%", height: "100%" }}
      />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {MESSAGES[index]}
        </p>
      </div>
    </div>
  );
}
