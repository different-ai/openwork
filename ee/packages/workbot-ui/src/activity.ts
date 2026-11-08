import type { LiveText, WorkbotStep, WorkbotTask, WorkbotTurn } from "./data";

/**
 * What Workbot is doing right now, for the status line under its name and the task sheet (`workingStatus`): one
 * short label, and behind it the steps of the reply in progress ("main") and of each background task. Worked out from
 * what the page already reads; nothing here reaches the chat itself.
 */
export type ActivityStep = { key: string; label: string; done: boolean; app: string | null };
export type ActivityTask = Pick<WorkbotTask, "id" | "title" | "status" | "startedAt" | "finishedAt" | "note" | "stepsDone"> & {
  /** What it is doing now, or did last. */
  current: string | null;
  steps: ActivityStep[];
  /**
   * Unfinished, but it hasn't taken a step for TASK_QUIET_MS: stopped or lost somewhere the conversation didn't hear
   * about. It stays in the sheet (with Stop) but never in the status line, so a job from hours ago can't read as "working".
   */
  quiet: boolean;
  /** Its latest sign of life: when it started or last took a step. */
  lastAt: number | null;
};
export type WorkbotActivity = {
  /** The signed-in conversation has answered; not a claim that its browser stream is connected. */
  connected?: boolean;
  /** Something is in progress: the reply, or a background task. */
  working: boolean;
  /** The status line: what it is doing now, in a few words. */
  label: string;
  icon: "browser" | "computer" | "app" | "task" | "thinking";
  /** The connected app in use, for its logo. */
  app: string | null;
  /** When the work on the line started, for its elapsed time. */
  since: number | null;
  /** The reply in progress: the person's message it answers, and its steps. Null while only tasks run. */
  main: { request: string; since: number | null; steps: ActivityStep[] } | null;
  /** Background tasks, unfinished first, then the latest few that ended. */
  tasks: ActivityTask[];
  /** A live screen Workbot is working on, which the person can ask to watch. */
  watch: "browser" | "computer" | null;
};

const OPEN = new Set<WorkbotTask["status"]>(["queued", "working", "paused"]);
export const taskOpen = (task: WorkbotTask) => OPEN.has(task.status);

/**
 * How long an unfinished task can go without a step before the header stops calling it work in progress. Long enough
 * for a slow build or download (one step), short enough that a task stopped where the conversation didn't hear about
 * it never shows as "3D room planner · 3h 33m".
 */
export const TASK_QUIET_MS = 20 * 60_000;

/** When a task last showed it was alive: its newest step, else when it started. */
function lastSign(task: WorkbotTask) {
  const times = [task.startedAt, ...task.steps.map((step) => step.at)].filter((at): at is number => typeof at === "number");
  return times.length ? Math.max(...times) : null;
}

/** The steps of one turn, in order: work in apps by their labels, work on the computer by what it said it did. */
function turnSteps(turn: WorkbotTurn, live: LiveText | null): ActivityStep[] {
  const steps: ActivityStep[] = [];
  const add = (step: ActivityStep) => {
    const previous = steps.at(-1);
    if (previous?.label === step.label) { previous.done = step.done; return; }
    steps.push(step);
  };
  turn.parts.forEach((part, index) => {
    if (part.kind !== "steps") return;
    part.steps.forEach((step: WorkbotStep, at) => {
      const key = `${index}:${at}`;
      if (step.icon === "app") { add({ key, label: step.label, done: step.status === "done", app: step.app }); return; }
      const updates = step.updates.length ? step.updates : [step.label];
      updates.forEach((update, n) => add({ key: `${key}:${n}`, label: update, done: step.status === "done" || n < updates.length - 1, app: null }));
    });
  });
  // A step the model has started but that isn't stored yet.
  const working = live && live.step >= turn.modelSteps ? live.working : undefined;
  if (working) {
    const label = working.update ?? (working.on === "computer" ? (working.background ? "Working on my computer" : "Using my computer") : null);
    if (label) add({ key: `live:${live?.step}`, label, done: false, app: null });
  }
  return steps;
}

const lastOpen = (steps: ActivityStep[]) => [...steps].reverse().find((step) => !step.done);

function taskActivity(task: WorkbotTask, now: number): ActivityTask {
  const steps = task.steps.map((step, index) => ({ key: `${task.id}:${index}`, label: step.label, done: step.done || !taskOpen(task), app: null }));
  const current = taskOpen(task) ? (task.update ?? lastOpen(steps)?.label ?? steps.at(-1)?.label ?? null) : (steps.at(-1)?.label ?? null);
  const lastAt = lastSign(task);
  const quiet = taskOpen(task) && lastAt !== null && now - lastAt >= TASK_QUIET_MS;
  return { id: task.id, title: task.title, status: task.status, startedAt: task.startedAt, finishedAt: task.finishedAt, note: task.note, stepsDone: task.stepsDone, current, steps, quiet, lastAt };
}

export function workbotActivity(turns: WorkbotTurn[], live: Record<string, LiveText>, now = Date.now()): WorkbotActivity {
  const answering = [...turns].reverse().find((turn) => !turn.greeting && (turn.status === "working" || turn.status === "queued")) ?? null;
  const allTasks = turns.flatMap((turn) => turn.tasks);
  // Unfinished tasks newest first, so the line names the job most recently handed off.
  const open = allTasks.filter(taskOpen).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const ended = allTasks.filter((task) => !taskOpen(task)).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(0, 3);
  const tasks = [...open, ...ended].map((task) => taskActivity(task, now));
  const liveText = answering ? (live[answering.id] ?? null) : null;
  const main = answering ? { request: answering.text, since: answering.sentAt, steps: turnSteps(answering, liveText) } : null;

  // The status line: the reply's step running now, then the reply itself (the person just asked), then the newest task
  // still at work. Stopped, finished and quiet tasks never hold the line.
  const running = (main ? lastOpen(main.steps) : undefined) ?? null;
  const surfaces = answering?.parts.flatMap((part) => (part.kind === "steps" ? part.steps : [])).filter((step) => step.icon === "computer" && step.status === "running" && !step.background) ?? [];
  const liveWorking = liveText && answering && liveText.step >= answering.modelSteps ? liveText.working : undefined;
  const screen = surfaces.at(-1)?.surface === "browser" ? "browser" : surfaces.length ? "computer" : liveWorking?.on === "computer" && !liveWorking.background ? "computer" : null;
  const task = tasks.find((entry) => (entry.status === "queued" || entry.status === "working" || entry.status === "paused") && !entry.quiet) ?? null;
  if (running) {
    return { working: true, label: running.label, icon: running.app ? "app" : screen ?? "computer", app: running.app, since: main?.since ?? null, main, tasks, watch: screen };
  }
  if (main) {
    return { working: true, label: liveText?.text ? "Writing" : "Thinking", icon: "thinking", app: null, since: main.since, main, tasks, watch: null };
  }
  if (task) {
    return { working: true, label: task.status === "queued" ? `${task.title} · waiting to start` : task.title, icon: "task", app: null, since: task.startedAt, main, tasks, watch: null };
  }
  return { working: false, label: "", icon: "thinking", app: null, since: null, main: null, tasks, watch: null };
}
