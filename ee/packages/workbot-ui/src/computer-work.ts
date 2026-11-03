import type { LiveText, WorkbotPart, WorkbotStep } from "./data";

/**
 * Where Workbot's computer cards go in a reply: pure, so it is tested without a page.
 */

/** Where on its computer Workbot works: its browser, its screen, or commands in the background with nothing to watch. */
export type ComputerSurface = "browser" | "computer" | "background";

export function surfaceOf(step: WorkbotStep): ComputerSurface {
  return step.surface === "browser" ? "browser" : step.background ? "background" : "computer";
}

/**
 * Workbot's computer work in one reply, as one card per kind of work (its browser, its screen, its background
 * commands), however often it stops to say what it is doing. While it works, the cards it is using go below its latest
 * words: the one it is on now, and the screen it was last on, which stays while it says what it is doing. Once it turns
 * to commands in the background, that screen is no longer watched until Workbot is back on it. The others stay where
 * that work last happened.
 *
 * Only a screen Workbot chose to show (the desktop tool's `show`) is `shown` with its live view: working on the screen
 * is not by itself a reason to put it in front of the person.
 *
 * `starts` is the card a step starting before it is stored belongs to, so what that step says it is doing shows there.
 */
export function computerWork(parts: WorkbotPart[], { working, starting, lastIsLive }: { working: boolean; starting: LiveText["working"] | null; lastIsLive: boolean }) {
  const cards = new Map<ComputerSurface, { steps: WorkbotStep[]; last: number }>();
  let screen: ComputerSurface | null = null;
  let current: ComputerSurface | null = null;
  // The kind of work it did last: after commands in the background, there is no screen to keep watching.
  let latest: ComputerSurface | null = null;
  // Whether Workbot is showing each screen: the last `show` it gave there in this reply.
  const showing = new Map<ComputerSurface, boolean>();
  let starts: ComputerSurface | null = null;
  for (const [index, part] of parts.entries()) {
    if (part.kind !== "steps") continue;
    for (const step of part.steps) {
      if (step.icon !== "computer") continue;
      const surface = surfaceOf(step);
      const card = cards.get(surface) ?? { steps: [], last: index };
      card.steps.push(step);
      card.last = index;
      cards.set(surface, card);
      if (surface !== "background") screen = surface;
      if (step.shown !== undefined) showing.set(surface, step.shown);
      latest = surface;
      if (lastIsLive && index === parts.length - 1) current = surface;
    }
  }
  if (working && starting) {
    // A step starting before it is stored: commands in the background, or the screen it was last on.
    const surface: ComputerSurface = starting.background ? "background" : screen ?? "computer";
    if (!cards.has(surface)) {
      cards.set(surface, { steps: [{ label: "Using my computer", icon: "computer", status: "running", app: null, startedAt: null, finishedAt: null, updates: [], ...(starting.background ? { background: true as const } : {}) }], last: parts.length });
    }
    current = surface;
    latest = surface;
    starts = surface;
  }
  const watch = working && latest !== "background" ? latest : null;
  const shown = watch && showing.get(watch) ? watch : null;
  const live = new Set<ComputerSurface>();
  if (working && current) live.add(current);
  if (watch) live.add(watch);
  const placed = new Map<number, ComputerSurface[]>();
  for (const [surface, card] of cards) if (!live.has(surface)) placed.set(card.last, [...(placed.get(card.last) ?? []), surface]);
  // Below its latest words: background work first, then the screen it is watched on.
  const trailing = [...live].sort((a, b) => Number(a === watch) - Number(b === watch));
  return { cards, live, watch, shown, placed, trailing, starts };
}
