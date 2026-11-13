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
 * commands), however often it stops to say what it is doing. Browser work stays at its first action for the whole
 * turn. Other live cards go below its latest words: the one it is on now, and the screen it was last on, which stays
 * while it says what it is doing. Once it turns to commands in the background, that screen is no longer watched until
 * Workbot is back on it. Other finished computer work stays where it last happened.
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
  const cards = new Map<ComputerSurface, { steps: WorkbotStep[]; first: number; last: number }>();
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
      const card = cards.get(surface) ?? { steps: [], first: index, last: index };
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
      cards.set(surface, { steps: [{ label, icon: "computer", status: "running", app: null, startedAt: null, finishedAt: null, updates: [], ...(surface === "browser" ? { surface: "browser" as const } : {}), ...(surface === "background" ? { background: true as const } : {}) }], first: parts.length, last: parts.length });
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
  // Browser work is one task per turn. Its card stays where it first started, including while live: narration and
  // later browser calls update that object rather than moving it down the conversation (DESIGN P11).
  for (const [surface, card] of cards) {
    if (surface !== "browser" && live.has(surface)) continue;
    const index = surface === "browser" ? card.first : card.last;
    placed.set(index, [...(placed.get(index) ?? []), surface]);
  }
  // Other computer work still follows its latest words: background work first, then the screen it is watched on.
  const trailing = [...live].filter((surface) => surface !== "browser").sort((a, b) => Number(a === watch) - Number(b === watch));
  return { cards, live, watch, shown, placed, trailing, starts };
}

/** Screen work stays as a preview or finished record. Background work lives in the task sheet unless watched. */
export function keepsCard(card: { surface: ComputerSurface; live: boolean; showing: boolean }) {
  return card.showing || card.surface !== "background";
}

export type BrowserTask = {
  title: string;
  status: "working" | "completed" | "failed";
  reason?: string;
};

/** The browser's one task for this turn; live, stored and reloaded cards use the same lifecycle. */
export function browserTask(
  steps: ReadonlyArray<{ status: string; reason?: string }>,
  { working, title, status, error, what = "browser task" }: {
    working: boolean;
    title: string;
    status?: "queued" | "working" | "done" | "failed" | "stopped";
    error?: string | null;
    /** What the work is called in a failure line: "browser task", or "computer task" for the rest of the computer. */
    what?: string;
  },
): BrowserTask {
  if (working) return { title, status: "working" };
  // Step status stays running|done for old clients; done means ended, while the additive reason preserves failure.
  const failure = [...steps].reverse().find((step) => step.reason || step.status === "failed");
  const unfinished = steps.some((step) => step.status === "running");
  if (failure || unfinished || status === "failed" || status === "stopped") {
    return {
      title,
      status: "failed",
      reason: error || failure?.reason || (status === "stopped" ? `Stopped before the ${what} finished.` : `The ${what} couldn't finish.`),
    };
  }
  return { title, status: "completed" };
}

/**
 * What a task's view says above the screen, or null while the live computer's state speaks instead. `rebuilt`: the
 * person rebuilt the computer from this view, which stopped the task. "Failed" above the new computer would read as
 * if rebuilding hadn't helped.
 */
export function taskHeader(task: Pick<BrowserTask, "status" | "reason"> | undefined, rebuilt: boolean): { status: "Completed" | "Failed" | "Stopped"; failed: boolean; reason?: string } | null {
  if (!task) return null;
  if (task.status === "completed") return { status: "Completed", failed: false };
  if (rebuilt) return { status: "Stopped", failed: false, reason: "Your computer was rebuilt, which stopped this task. Ask again to run it on the new computer." };
  return task.status === "failed" ? { status: "Failed", failed: true, ...(task.reason ? { reason: task.reason } : {}) } : null;
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
