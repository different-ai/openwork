import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RemoteJobs, followConversation, orderRemoteJobs, remoteJobActivity, remoteJobStateLabel, remoteJobUpdatedLabel, remoteJobsPollMs, remoteWatcherTaskIds, retainRemoteStatuses, useWorkbotRemoteJobs } from "../../../packages/workbot-ui/src/remote-jobs";
import { setWorkbotHost, type WorkbotHost } from "../../../packages/workbot-ui/src/host";
import type { WorkbotRemoteJob } from "@openwork/types/workbot-remote-jobs";

let requests = 0;
const host: WorkbotHost = {
  requestJson: async () => { requests++; return { response: new Response(), payload: {} }; },
  prepare: async path => ({ url: path, headers: new Headers(), credentials: "same-origin" }),
  user: null, useConnectedApps: () => [], appIcons: () => [], homeHref: "/",
};
setWorkbotHost(host);
const job: WorkbotRemoteJob = { key: "command:one", ref: { commandId: "one" }, title: "Review the draft", target: "registered", toolCallId: "create_1", turnId: "request", startedAt: 100, watcherTaskIds: ["watcher_exact_id"], stale: false,
  status: { ref: "one", changed: true, version: "v1", target: "desktop", state: "waiting", waitingFor: "permission", title: null, computerId: "computer_1", computerLabel: "Work computer", sessionId: "session_1", workspaceId: null, messageCount: 1, preview: null, error: null, observedAt: 1000, latestStep: "Reading the draft", pending: { kind: "permission", requestId: "pending_1", title: "<script>Approve deletion?</script>" } },
};
assert.equal(remoteJobStateLabel(job), "Needs approval");
assert.equal(remoteJobActivity([job])?.waiting, true);
assert.deepEqual([...remoteWatcherTaskIds([job])], ["watcher_exact_id"]);
const waiting = renderToStaticMarkup(<RemoteJobs jobs={[job]} />);
assert.ok(waiting.includes("Needs approval"));
const summary = waiting.slice(waiting.indexOf("<summary"), waiting.indexOf("</summary>"));
assert.ok(summary.includes("Work computer") && summary.includes("Reading the draft"), "computer and latest step stay visible while collapsed");
assert.ok(summary.includes("Review the draft") && summary.includes("Needs approval"));
assert.ok(waiting.includes("Latest reported step"), "only the reported step, never invented history");
assert.ok(waiting.includes("Nothing has been approved here"));
assert.ok(waiting.includes("&lt;script&gt;Approve deletion?&lt;/script&gt;"));
assert.ok(!waiting.includes("<script>"));
assert.ok(!waiting.includes("<button"), "no implicit approve/stop actions");
const unverified = retainRemoteStatuses({ jobs: [{ ...job, stale: true, status: null }], hasEarlier: false }, { jobs: [job], hasEarlier: false });
assert.equal(unverified.jobs[0]?.status?.state, "waiting");
assert.equal(remoteJobActivity(unverified.jobs), null, "old state never holds working status");
// A failed refresh keeps the last state with a quiet age, never a warning (production: every row said "Couldn't verify now").
assert.equal(remoteJobStateLabel(unverified.jobs[0]!), "Needs approval");
const now = 10 * 60_000;
const aged = { ...unverified.jobs[0]!, checkedAt: now - 5 * 60_000 };
assert.equal(remoteJobUpdatedLabel(aged, now), "Updated 5m ago");
assert.equal(remoteJobUpdatedLabel(job, now), null, "a fresh row shows no age");
assert.equal(remoteJobUpdatedLabel({ ...aged, status: { ...aged.status!, state: "idle" } }, now), null, "a finished task's state is final; no age");
const agedMarkup = renderToStaticMarkup(<RemoteJobs jobs={[aged]} />);
assert.ok(agedMarkup.includes("data-workbot-remote-updated") && !agedMarkup.includes("Couldn"), "quiet age, no warning text");
assert.ok(!agedMarkup.includes("lucide-circle-alert"), "no warning icon for a failed refresh");
const checkedLater = retainRemoteStatuses({ jobs: [{ ...job, stale: true, status: null, checkedAt: 42 }], hasEarlier: false }, { jobs: [job], hasEarlier: false });
assert.equal(checkedLater.jobs[0]?.checkedAt, 42, "keeps when the state was last checked");
// Only a task that truly can't be reached gets a warning, with a plain reason.
const never: WorkbotRemoteJob = { ...job, key: "cloud:never", ref: { sessionId: "never" }, target: "cloud", status: null, stale: true, unreachable: "Can't reach your cloud computer right now." };
assert.equal(remoteJobStateLabel(never), "Can't reach it");
const neverMarkup = renderToStaticMarkup(<RemoteJobs jobs={[never]} />);
assert.ok(neverMarkup.includes("lucide-circle-alert") && neverMarkup.includes("Can&#x27;t reach your cloud computer right now."));
assert.equal(remoteJobStateLabel({ ...never, unreachable: null }), "Not checked yet");
assert.ok(!renderToStaticMarkup(<RemoteJobs jobs={[{ ...never, unreachable: null }]} />).includes("lucide-circle-alert"), "not checked yet is not a warning");
assert.ok(renderToStaticMarkup(<RemoteJobs jobs={[job]} statusError="signed_out" />).includes("signed out"), "auth failure says so plainly");
// Ordering: running and waiting first, then finished below with a checkmark.
const status = job.status!;
const finishedOld: WorkbotRemoteJob = { ...job, key: "command:done-old", title: "Done earlier", startedAt: 10, status: { ...status, state: "idle" } };
const running: WorkbotRemoteJob = { ...job, key: "command:running", title: "Still running", startedAt: 50, status: { ...status, state: "running" } };
const finishedNew: WorkbotRemoteJob = { ...job, key: "command:done-new", title: "Done just now", startedAt: 300, status: { ...status, state: "idle" } };
const failed: WorkbotRemoteJob = { ...job, key: "command:failed", title: "Failed", startedAt: 200, status: { ...status, state: "error" } };
const ordered = orderRemoteJobs([finishedOld, finishedNew, running, job, failed]);
assert.deepEqual(ordered.active.map(entry => entry.key), ["command:one", "command:running"]);
assert.deepEqual(ordered.finished.map(entry => entry.key), ["command:done-new", "command:failed", "command:done-old"]);
const list = renderToStaticMarkup(<RemoteJobs jobs={[finishedOld, finishedNew, running, job]} />);
assert.ok(list.indexOf("Still running") < list.indexOf(">Finished<") && list.indexOf(">Finished<") < list.indexOf("Done just now"), "finished tasks sit below the running ones");
const finishedList = list.slice(list.indexOf("data-workbot-remote-finished"));
assert.ok(finishedList.includes("lucide-check"), "finished tasks show a checkmark");
for (const [state, label] of [["idle", "Finished"], ["error", "Couldn't finish"], ["running", "Working"], ["starting", "Waiting for computer"]] as const) {
  assert.ok(job.status);
  assert.equal(remoteJobStateLabel({ ...job, status: { ...job.status, state } }), label);
}
// The list is polled quickly only while a task may still change, slowly once all are finished, and not at all with none.
assert.equal(remoteJobsPollMs({ jobs: [running, finishedOld], hasEarlier: false }, false), 15_000);
assert.equal(remoteJobsPollMs({ jobs: [job], hasEarlier: false }, false), 15_000, "waiting on the person is still open");
assert.equal(remoteJobsPollMs({ jobs: [{ ...job, stale: true }], hasEarlier: false }, true), 15_000, "a failed refresh keeps following an open task");
assert.equal(remoteJobsPollMs({ jobs: [never], hasEarlier: false }, false), 15_000, "a task not checked yet is tried again");
assert.equal(remoteJobsPollMs({ jobs: [finishedOld, failed], hasEarlier: false }, false), 60_000, "a finished task may be continued elsewhere");
assert.equal(remoteJobsPollMs({ jobs: [], hasEarlier: false }, false), false);
assert.equal(remoteJobsPollMs(undefined, false), false);
assert.equal(remoteJobsPollMs(undefined, true), 60_000, "a read that failed is tried again, slowly");
// A new task is found when the conversation changes, not by a timer: at most one re-read per 15 s, never while hidden.
async function conversationFollowed() {
  const queries = new QueryClient();
  const remoteKey = ["workbot", "remote-jobs", undefined, "main"];
  const thread = ["workbot", "thread", "main", 30];
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));
  const invalidated = () => queries.getQueryState(remoteKey)?.isInvalidated === true;
  const settle = (updatedAt: number) => queries.setQueryData(remoteKey, { jobs: [], hasEarlier: false }, { updatedAt });
  let hidden = false;
  let clock = 1_000_000;
  queries.setQueryData(thread, { turns: [{ id: "one", steps: 1 }] });
  settle(clock - 60_000);
  const following = followConversation(queries, { chat: null, remoteKey, hidden: () => hidden, now: () => clock });
  queries.setQueryData(thread, { turns: [{ id: "one", steps: 1 }] });
  await tick();
  assert.equal(invalidated(), false, "a re-read that changed nothing looks for nothing");
  queries.setQueryData(["workbot", "thread", "sidechat000000001", 30], { turns: [{ id: "other", steps: 1 }] });
  queries.setQueryData(["workbot", "thread", "sidechat000000001", 30], { turns: [{ id: "other", steps: 2 }] });
  await tick();
  assert.equal(invalidated(), false, "another chat's change is not this chat's");
  queries.setQueryData(thread, { turns: [{ id: "one", steps: 2 }] });
  await tick();
  assert.equal(invalidated(), true, "a step landed: the list is read again");
  // Read a moment ago: the next change waits for the rest of the 15 s rather than reading on every step.
  settle(clock);
  queries.setQueryData(thread, { turns: [{ id: "one", steps: 3 }] });
  await tick();
  assert.equal(invalidated(), false);
  following.stop();
  // Hidden: the change is kept for when the page is shown.
  settle(clock - 60_000);
  const quiet = followConversation(queries, { chat: null, remoteKey, hidden: () => hidden, now: () => clock });
  hidden = true;
  queries.setQueryData(thread, { turns: [{ id: "one", steps: 4 }] });
  await tick();
  assert.equal(invalidated(), false, "a hidden page reads nothing");
  hidden = false;
  quiet.shown();
  assert.equal(invalidated(), true);
  quiet.stop();
  settle(clock - 60_000);
  queries.setQueryData(thread, { turns: [{ id: "one", steps: 5 }] });
  await tick();
  assert.equal(invalidated(), false, "stopped");
}
setWorkbotHost(host);
assert.ok(renderToStaticMarkup(<RemoteJobs jobs={[job]} />).includes("data-workbot-remote-job"), "remote jobs are always visible");
assert.equal(requests, 0);
void conversationFollowed().then(
  () => console.log("remote jobs UI: safe pending text, truthful states, stale retention, explicit watcher ids, polling only open tasks passed"),
  (error: unknown) => { console.error(error); process.exitCode = 1; },
);
