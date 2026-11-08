import type { LiveText, WorkbotPart, WorkbotStep } from "./data";

/**
 * Where Workbot's computer cards go in a reply: pure, so it is tested without a page.
 */

/**
 * What a step starting before it is stored is doing, after one more live `working` event for it. Where a call works
 * (`surface`) and what it does (`update`) arrive after its start; the same kind of work keeps them until a later event
 * says otherwise, so a card that knows it is the browser never goes back to not knowing.
 */
export function nextWorking(previous: LiveText["working"] | undefined, value: { on: "computer" | "other"; background?: true; surface?: "browser" | "computer"; update?: string }, now = Date.now()): NonNullable<LiveText["working"]> {
  const same = previous?.on === value.on && previous.background === value.background ? previous : undefined;
  const update = value.update ?? same?.update;
  const surface = value.surface ?? same?.surface;
  return { on: value.on, since: now, ...(value.background ? { background: true as const } : {}), ...(surface ? { surface } : {}), ...(update ? { update } : {}) };
}

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
 * Such a step has a card from its first frame only once its kind is known: commands in the background, or the screen
 * the call names (`surface`). Screen work that hasn't said which screen yet gets no card at all, never a guess that
 * would turn from "Computer" into "Browser" a moment later.
 */
export function computerWork(parts: WorkbotPart[], { working, starting, lastIsLive }: { working: boolean; starting: LiveText["working"] | null; lastIsLive: boolean }) {
  const cards = new Map<ComputerSurface, { steps: WorkbotStep[]; last: number }>();
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
      if (step.shown !== undefined) showing.set(surface, step.shown);
      latest = surface;
      if (lastIsLive && index === parts.length - 1) current = surface;
    }
  }
  // A step starting before it is stored: commands in the background, or the screen the call says it works on.
  const startingOn: ComputerSurface | null = !working || !starting ? null : starting.background ? "background" : starting.surface ?? null;
  if (startingOn) {
    const surface = startingOn;
    if (!cards.has(surface)) {
      const label = surface === "browser" ? "Using the browser" : surface === "background" ? "Working on my computer" : "Using my computer";
      cards.set(surface, { steps: [{ label, icon: "computer", status: "running", app: null, startedAt: null, finishedAt: null, updates: [], ...(surface === "browser" ? { surface: "browser" as const } : {}), ...(surface === "background" ? { background: true as const } : {}) }], last: parts.length });
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

/**
 * Whether a computer card stays in the conversation. With the working status (`quiet`), live work shows under
 * Workbot's name rather than in the chat, so a live card shows only while Workbot shows its screen or, with the inline
 * preview, while it works on a screen. Once work on its browser or screen is over, its card stays where it happened as
 * a finished record, like anything else Workbot said, and is read back with the conversation after a reload. Commands
 * in the background leave no card: the task sheet keeps them.
 */
export function keepsCard(card: { surface: ComputerSurface; live: boolean; showing: boolean }, { quiet, preview }: { quiet: boolean; preview: boolean }) {
  if (!quiet || card.showing) return true;
  if (card.surface === "background") return false;
  return card.live ? preview : true;
}

/**
 * What finished work on a screen comes to, in one line: the page it opened ("Opened google.com", "Opened
 * google.com and 2 more"), else the last thing it said it did, else that it used its browser or computer.
 */
export function finishedSummary(surface: Exclude<ComputerSurface, "background">, steps: WorkbotStep[]): string {
  const pages = steps.flatMap((step) => step.pages ?? []).filter((page, index, all) => all.findIndex((entry) => entry.id === page.id) === index);
  const last = pages.at(-1);
  if (last) return pages.length > 1 ? `Opened ${last.title} and ${pages.length - 1} more` : `Opened ${last.title}`;
  return steps.flatMap((step) => step.updates).at(-1) ?? (surface === "browser" ? "Used the browser" : "Used my computer");
}
