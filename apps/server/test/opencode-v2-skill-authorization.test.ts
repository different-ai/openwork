import assert from "node:assert/strict";
import { test } from "node:test";
import { createV2ContextBridge } from "../src/opencode-v2-context-bridge.js";
import { sha256Digest } from "../src/opencode-plugins/openwork-cloud-skills-v2.js";

const listed = { name: "fixture-review", description: "Review a fixture.", modelDiscovery: true,
  url: "skill://fixture-review/SKILL.md", capability: "skill:fixture-review", digest: sha256Digest("fixture body") };
const snapshot = { id: "openwork-cloud-fixture-review", url: listed.url, capability: listed.capability, digest: listed.digest };
const sessionID = "ses_fixture";
const skills = [snapshot];

test("native authorization is token-scoped, loadable-snapshot-bound, and off with the rollout", async () => {
  let native = false;
  let entries: unknown[] = [listed];
  const evaluations: Array<{ sessionID: string; ids: string[] }> = [];
  const bridge = await createV2ContextBridge(async path => {
    assert.equal(path, "/experimental/connect/skills?fresh=true");
    return { skills: entries, ...(native ? { delivery: "native" } : {}) };
  }, async (sessionID, ids) => {
    evaluations.push({ sessionID, ids });
    return { data: { id: "per_fixture", effect: "deny" } };
  });
  const call = (input: unknown, token = bridge.token) => fetch(bridge.url, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "openwork_skill_authorize", input }),
  });
  try {
    assert.equal((await call({ sessionID, skills }, "wrong-token")).status, 401);
    assert.equal((await call({ sessionID, skills })).status, 403);
    native = true;
    for (const input of [
      { sessionID: "../session", skills }, { sessionID, skills: [{ ...snapshot, id: "local-skill" }] },
      { sessionID, skills: [] }, { sessionID, skills: Array.from({ length: 151 }, () => snapshot) },
      { sessionID, skills, action: "shell" }, { sessionID, skills, decision: "always" },
      { sessionID, ids: [snapshot.id] },
    ]) assert.equal((await call(input)).status, 400);
    for (const change of [
      { name: "removed-review" }, { modelDiscovery: false }, { digest: undefined },
      { setup: { status: "needs_connection", message: "Connect the fixture service." }, digest: undefined },
      { digest: sha256Digest("new body") }, { url: "skill://different/SKILL.md" }, { capability: "skill:different" },
    ]) {
      entries = [{ ...listed, ...change }];
      assert.equal((await call({ sessionID, skills })).status, 403, "a visible name cannot authorize an old or withheld body");
    }
    assert.equal(evaluations.length, 0, "invalid, unready and stale snapshots never reach permission evaluation");
    entries = [listed];
    const response = await call({ sessionID, skills });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { id: "per_fixture", effect: "deny" } });
    assert.deepEqual(evaluations, [{ sessionID, ids: [snapshot.id] }]);
    native = false;
    assert.equal((await call({ sessionID, skills })).status, 403);
    assert.equal(evaluations.length, 1);
  } finally { await bridge.close(); }
});

test("authorization rechecks loadability and identity after the engine permission operation", async () => {
  for (const change of [
    { setup: { status: "needs_connection", message: "Connect the fixture service." }, digest: undefined },
    { digest: sha256Digest("new body") }, { url: "skill://different/SKILL.md" }, { capability: "skill:different" },
  ]) {
    let current: unknown = listed;
    let evaluations = 0;
    const bridge = await createV2ContextBridge(async () => ({ delivery: "native", skills: [current] }), async () => {
      evaluations++; current = { ...listed, ...change };
      return { data: { effect: "allow" } };
    });
    try {
      const response = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "openwork_skill_authorize", input: { sessionID, skills } }) });
      assert.equal(evaluations, 1, "witness: the catalog changed while permission evaluation was in flight");
      assert.equal(response.status, 403);
    } finally { await bridge.close(); }
  }
});
