import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RemoteJobs, orderRemoteJobs, remoteJobActivity, remoteJobStateLabel, remoteJobUpdatedLabel, remoteWatcherTaskIds, retainRemoteStatuses, useWorkbotRemoteJobs } from "../../../packages/workbot-ui/src/remote-jobs";
import { setWorkbotHost, type WorkbotHost } from "../../../packages/workbot-ui/src/host";
import type { WorkbotRemoteJob } from "@openwork/types/workbot-remote-jobs";

let requests = 0;
const host: WorkbotHost = {
  requestJson: async () => { requests++; return { response: new Response(), payload: {} }; },
  prepare: async path => ({ url: path, headers: new Headers(), credentials: "same-origin" }),
  user: null, useConnectedApps: () => [], appIcons: () => [], homeHref: "/", remoteTasks: true,
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
setWorkbotHost({ ...host, remoteTasks: false });
assert.equal(renderToStaticMarkup(<RemoteJobs jobs={[job]} />), "", "flag-off UI masks cached data");
const client = new QueryClient();
client.setQueryData(["workbot", "remote-jobs", undefined, "main"], { jobs: [job], hasEarlier: false });
function Probe() {
  const query = useWorkbotRemoteJobs(true);
  assert.equal(query.data, undefined, "disabled hook must not reveal previously cached jobs");
  return null;
}
renderToStaticMarkup(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
assert.equal(requests, 0);
console.log("remote jobs UI: safe pending text, truthful states, stale retention, explicit watcher ids, default-off cache masking passed");
