import assert from "node:assert/strict";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ActivityDetails, collapseRepeats, ProfileBadge, taskStatusLine, taskTime, WorkingName } from "../../../packages/workbot-ui/src/working-status";
import { sheetDragCloses } from "../../../packages/workbot-ui/src/sheet-drag";
import { setWorkbotHost, type WorkbotHost } from "../../../packages/workbot-ui/src/host";
import type { ActivityStep, ActivityTask, WorkbotActivity } from "../../../packages/workbot-ui/src/activity";

/**
 * ENG-1143: tapping Workbot on a phone opens what clicking it opens on desktop, and background tasks are one row each
 * with their steps behind the row, never a list of internal steps at the top level.
 */
const base: WorkbotHost = {
  requestJson: async () => ({ response: new Response(), payload: {} }),
  prepare: async path => ({ url: path, headers: new Headers(), credentials: "same-origin" }),
  user: null, useConnectedApps: () => [], appIcons: () => [], homeHref: "/",
};
const render = (node: ReactElement) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
const count = (markup: string, text: string) => markup.split(text).length - 1;

const at = new Date(2026, 10, 9, 14, 4).getTime();
const polls = (id: string, times: number): ActivityStep[] => Array.from({ length: times }, (_, index) => ({ key: `${id}:${index}`, label: "Checking the remote task", done: true, app: null }));
const task = (id: string, title: string, status: ActivityTask["status"], steps: ActivityStep[], extra: Partial<ActivityTask> = {}): ActivityTask =>
  ({ id, title, status, startedAt: at - 60_000, finishedAt: status === "done" || status === "stopped" ? at + 60_000 : null, note: null, stepsDone: steps.length, current: steps.at(-1)?.label ?? null, steps, quiet: false, lastAt: at, ...extra });
const tasks = [
  task("watch", "Watch the browser fix", "working", polls("watch", 7), { quiet: true }),
  task("checks", "Watch the release checks", "working", polls("checks", 5)),
  task("notes", "Draft the release notes", "done", [{ key: "notes:0", label: "Reading the merged changes", done: true, app: null }, ...polls("notes", 3)]),
  task("planner", "3D room planner", "stopped", []),
];
const idle: WorkbotActivity = { working: false, label: "", icon: "thinking", app: null, since: null, main: null, tasks, watch: null, connected: true };

// Repeats in a row become one counted step; different or separated steps stay apart.
const collapsed = collapseRepeats([...polls("a", 7), { key: "b", label: "Writing the notes", done: true, app: null }, ...polls("c", 2)]);
assert.deepEqual(collapsed.map(step => [step.label, step.count]), [["Checking the remote task", 7], ["Writing the notes", 1], ["Checking the remote task", 2]]);

// One plain status line and a time per task.
assert.equal(taskStatusLine(tasks[0]!), `No progress since ${new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`);
assert.equal(taskStatusLine(tasks[1]!), "Checking the remote task");
assert.equal(taskStatusLine(tasks[2]!), "Done");
assert.equal(taskStatusLine(tasks[3]!), "Stopped");
assert.equal(taskTime(tasks[2]!), new Date(at + 60_000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }), "ended tasks show when they ended");

// The sheet body (the profile's Tasks tab and the task sheet): one row per task, no step rows until a row is opened.
setWorkbotHost(base);
const details = render(<ActivityDetails name="Workbot" activity={idle} />);
assert.equal(count(details, "data-workbot-sheet-task="), 4, "one row per background task");
assert.equal(count(details, "data-workbot-task-line"), 4, "each row has exactly one status line");
assert.equal(count(details, "data-workbot-sheet-steps"), 0, "no step list at the top level");
assert.equal(count(details, "Checking the remote task"), 1, "the repeated internal step never fills the sheet; only the live task's status line names it");
assert.equal(count(details, ">Stop<"), 2, "Stop stays on each unfinished task");
assert.equal(count(details, 'aria-expanded="false"'), 3, "tasks with steps open on tap, collapsed by default");

// The reply in progress still lists its own steps; background tasks below it stay one row each.
const answering: WorkbotActivity = { ...idle, working: true, label: "Searching Slack", main: { request: "Find the notes", since: at, steps: [{ key: "m0", label: "Searching Slack", done: false, app: null }] } };
const withMain = render(<ActivityDetails name="Workbot" activity={answering} />);
assert.equal(count(withMain, "data-workbot-sheet-steps"), 1, "only the reply's own steps are listed");
assert.equal(count(withMain, "data-workbot-sheet-task="), 4);

// Phone and desktop open the same sheet: the phone's name pill and the desktop avatar say and do the same thing.
const label = (markup: string) => /aria-label="([^"]*)"/.exec(markup)?.[1];
setWorkbotHost(base);
for (const activity of [idle, { ...idle, tasks: [] }]) {
  const phone = render(<WorkingName name="Workbot" activity={activity} mark={null} phone />);
  const desktop = render(<ProfileBadge name="Workbot" activity={activity} />);
  assert.equal(label(phone), label(desktop), `same profile on phone and desktop (${activity.tasks.length} tasks)`);
  assert.equal(label(phone), "Workbot: open profile");
  assert.ok(!phone.includes('disabled=""'), "the phone pill always opens its profile, like the avatar");
}

// Pulling the phone sheet down: far or fast enough closes it, a small slow pull springs back.
assert.equal(sheetDragCloses(200, 0.1, 800), true);
assert.equal(sheetDragCloses(40, 0.1, 800), false);
assert.equal(sheetDragCloses(40, 0.9, 800), true);
assert.equal(sheetDragCloses(10, 2, 800), false, "a flick under the slop is a tap");

console.log("working-status-ui: ok");
