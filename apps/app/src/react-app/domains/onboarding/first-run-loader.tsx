/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

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

/**
 * Full-screen loader shown on a brand-new install while the first session is
 * being created, so the "select or create a session" page never flashes.
 */
export function FirstRunLoader() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setIndex((current) => (current + 1) % MESSAGES.length);
    }, 1800);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background">
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {MESSAGES[index]}
      </p>
    </div>
  );
}
