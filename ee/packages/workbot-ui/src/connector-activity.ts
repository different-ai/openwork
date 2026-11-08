import type { LiveText, WorkbotStep, WorkbotTurn } from "./data";

/**
 * Work in the person's connected apps during one answer (Exa, Gmail, Linear, a remote computer), summed up for the
 * quiet line under that answer and the header's status line, so both say the same thing. While Workbot is at it:
 * "Searching Exa · 2 searches". Once it has moved on: "Used Exa · 2 searches", which opens the list of what ran.
 */
export type ConnectorApp = { name: string | null; site?: string; remote?: true };
export type ConnectorRow = { key: string; label: string; detail: string | null; times: number; app: ConnectorApp };
export type ConnectorSummary = {
  /** Workbot is working in an app right now (or still on what it found there, with nothing newer said or done). */
  live: boolean;
  /** What it is doing now ("Searching Exa"), or what it did ("Used Exa"). */
  label: string;
  /** "2 searches", "3 actions"; null for one. */
  count: string | null;
  /** The apps used, in the order first used. */
  apps: ConnectorApp[];
  /** The app of the latest step, for the leading logo. */
  latest: ConnectorApp;
  /** Each tool that ran, in order; the same one again in a row is one row with `times`. */
  rows: ConnectorRow[];
};

const appOf = (step: WorkbotStep): ConnectorApp => ({ name: step.app, ...(step.site ? { site: step.site } : {}), ...(step.remote ? { remote: true as const } : {}) });
const appKey = (app: ConnectorApp) => (app.remote ? "remote" : app.name ?? "app");

/** "Exa", "Exa and Gmail", "Exa, Gmail and Linear"; "a connected app" when the app couldn't be named. */
function names(apps: ConnectorApp[]) {
  const list = apps.map((app) => (app.remote ? "a remote computer" : app.name ?? "a connected app"));
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/** The answer's work in apps, or null when it used none. */
export function connectorSummary(turn: WorkbotTurn, live: LiveText | null): ConnectorSummary | null {
  const steps = turn.parts.flatMap((part) => (part.kind === "steps" ? part.steps.filter((step) => step.icon === "app") : []));
  const latestStep = steps.at(-1);
  if (!latestStep) return null;
  const working = turn.status === "working" || turn.status === "queued";
  // Words being written after the app work, or work on its computer since, mean it has moved on.
  const current = working && live && live.step >= turn.modelSteps ? live : null;
  const writing = Boolean(current?.text.trim()) || Boolean(current?.working?.on === "computer");
  const last = turn.parts.at(-1);
  const trailing = last?.kind === "steps" && last.steps.at(-1)?.icon === "app";
  const isLive = working && (steps.some((step) => step.status === "running") || (trailing && !writing));

  const apps: ConnectorApp[] = [];
  for (const step of steps) {
    const app = appOf(step);
    if (!apps.some((entry) => appKey(entry) === appKey(app))) apps.push(app);
  }
  const rows: ConnectorRow[] = [];
  steps.forEach((step, index) => {
    const label = step.label;
    const detail = step.detail && step.detail !== label ? step.detail : null;
    const previous = rows.at(-1);
    if (previous && previous.label === label && previous.detail === detail) { previous.times += 1; return; }
    rows.push({ key: `${index}`, label, detail, times: 1, app: appOf(step) });
  });
  const searches = steps.every((step) => step.label.startsWith("Searching "));
  const count = steps.length > 1 ? `${steps.length} ${searches ? "searches" : "actions"}` : null;
  // Live: what it is doing now. Several of the same in a row are one line that counts them.
  const running = [...steps].reverse().find((step) => step.status === "running") ?? latestStep;
  const label = isLive ? running.label : `Used ${names(apps)}`;
  return { live: isLive, label, count, apps, latest: appOf(running), rows };
}
