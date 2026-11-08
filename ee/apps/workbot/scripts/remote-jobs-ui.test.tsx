import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RemoteJobs, remoteJobActivity, remoteJobStateLabel, remoteWatcherTaskIds, retainRemoteStatuses, useWorkbotRemoteJobs } from "../../../packages/workbot-ui/src/remote-jobs";
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
assert.equal(remoteJobStateLabel(unverified.jobs[0]!), "Couldn't verify now");
assert.ok(renderToStaticMarkup(<RemoteJobs jobs={unverified.jobs} />).includes("Last known state: waiting for you"));
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
