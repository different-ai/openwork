// Node 22+: a single participant child serves all three products and restores separate stores.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = "/private/var/folders/8j/hhcc8zs100d3fd654fjkk9580000gn/T/opencode";
async function launch(t, directory) {
  const child = fork(new URL("./workshop-worker.mjs", import.meta.url), [], {
    env: { PATH: process.env.PATH, OPEN_WORKPLACE_PERSON: "Alex Chen|alex|CEO", OPEN_WORKPLACE_NOW: "2026-10-16T16:00:00Z", ...(directory ? { OPEN_WORKPLACE_PARTICIPANT_DATA_DIR: directory } : {}) },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  };
  t.after(stop);
  const ports = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Participant startup timed out")); }, 15000);
    child.on("message", (message) => {
      if (message.type !== "workshop-ready") return;
      clearTimeout(timer); resolve(message.ports);
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Participant exited before startup")); });
  });
  assert.equal(new Set(Object.values(ports)).size, 3);
  async function request(service, path, method = "GET", body) {
    const response = await fetch(`http://127.0.0.1:${ports[service]}${path}`, {
      method, headers: { authorization: "Bearer open-workplace-token", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(response.ok, `HTTP ${response.status}`);
    return response;
  }
  return { child, stop, request };
}

test("one child exposes Microsoft REST, Jira REST and web with distinct durable snapshots and restart recovery", { timeout: 30000 }, async (t) => {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "workshop-worker-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let worker = await launch(t, directory);
  assert.equal((await (await worker.request("microsoft", "/v1.0/me")).json()).mail, "alex@acme.test");
  const message = await (await worker.request("microsoft", "/v1.0/me/messages", "POST", { subject: "Worker durable draft" })).json();
  const state = await (await worker.request("atlassian", "/state")).json();
  const issue = state.jira.issues[0].key;
  await worker.request("atlassian", `/jira/rest/api/2/issue/${issue}`, "PUT", { fields: { summary: "Worker durable issue" } });
  assert.match(await (await worker.request("web", "/jira")).text(), /Open Jira/);
  assert.match(await (await worker.request("web", "/confluence")).text(), /Open Confluence/);
  const proxied = await (await worker.request("web", `/api/atlassian/jira/rest/api/2/issue/${issue}`)).json();
  assert.equal(proxied.fields.summary, "Worker durable issue");
  for (const [file, key] of [["microsoft.sqlite", "microsoft365"], ["atlassian.sqlite", "atlassian"]]) {
    const db = new DatabaseSync(join(directory, file));
    try { assert.deepEqual(db.prepare("SELECT key FROM snapshots").all().map((row) => row.key), [key]); }
    finally { db.close(); }
  }
  const beforeMicrosoft = await (await worker.request("microsoft", "/state")).json();
  const beforeAtlassian = await (await worker.request("atlassian", "/state")).json();
  await worker.stop();
  worker = await launch(t, directory);
  assert.deepEqual(await (await worker.request("microsoft", "/state")).json(), beforeMicrosoft);
  assert.deepEqual(await (await worker.request("atlassian", "/state")).json(), beforeAtlassian);
  assert.equal((await (await worker.request("microsoft", `/v1.0/me/messages/${message.id}`)).json()).subject, "Worker durable draft");
  assert.equal((await (await worker.request("web", `/api/atlassian/jira/rest/api/2/issue/${issue}`)).json()).fields.summary, "Worker durable issue");
  const exited = once(worker.child, "exit"); worker.child.disconnect();
  assert.equal((await exited)[0], 0);
});
