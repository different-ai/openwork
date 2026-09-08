import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { assignmentToolCatalog, createAssignmentToolHandlers, createSelfToolHandlers, selfToolCatalog } from "./assignment-tools.mjs";
import { createCoworker, readCoworkerFile } from "./coworkers.mjs";
import { createCoworkerToolsServer } from "./coworker-tools.mjs";
import { listLocalResponsibilities } from "./local-responsibilities.mjs";
import { normalizeSettings } from "./settings.mjs";

const roots = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "coworker-tools-"));
  roots.push(root);
  const coworkersDir = path.join(root, "coworkers");
  await createCoworker(coworkersDir, { name: "Scout", role: "Research partner" });
  await createCoworker(coworkersDir, { name: "Nova" });
  const runs = [];
  const handlers = {
    ...createAssignmentToolHandlers({
      coworkersDir,
      settings: async () => normalizeSettings({}),
      timezone: () => "UTC",
      runNow: async (slug, id) => {
        runs.push({ slug, id });
        return { accepted: true, queued: false, reason: "" };
      },
      cloud: null,
    }),
    ...createSelfToolHandlers({ coworkersDir }),
  };
  const tools = [...assignmentToolCatalog(), ...selfToolCatalog()];
  return { coworkersDir, tools, handlers, runs };
}

/** The shared loopback server with only these tools on it, bound to the given tokens. */
async function serve({ tools, handlers }, tokens) {
  return createCoworkerToolsServer({ resolveSlug: (token) => tokens.get(token) ?? null, handlers, tools, version: "1.2.3" });
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

let nextId = 1;
function rpc(method, params) {
  nextId += 1;
  return { jsonrpc: "2.0", id: nextId, method, ...(params ? { params } : {}) };
}

async function call(server, token, method, params) {
  const response = await fetch(server.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(rpc(method, params)),
  });
  return { status: response.status, body: response.status === 202 ? null : await response.json() };
}

function resultText(reply) {
  return reply.body.result.content.map((part) => part.text).join("\n");
}

test("authenticated assignment dispatch isolates owners and rejects unavailable or unsafe actions", async () => {
  const fixtureState = await fixture();
  const { coworkersDir, runs } = fixtureState;
  const scout = "scout-token";
  const nova = "nova-token";
  const tokens = new Map([[scout, "scout"], [nova, "nova"]]);
  const server = await serve(fixtureState, tokens);
  try {
    assert.equal((await fetch(server.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rpc("tools/list")) })).status, 401);
    const created = await call(server, scout, "tools/call", {
      name: "assignment_create",
      arguments: {
        name: "Move the car",
        instructions: "Remind me to move the car for street cleaning.",
        schedule: { kind: "weekly", daysOfWeek: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
      },
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.result.isError, false);
    const scoutItems = await listLocalResponsibilities(coworkersDir, "scout");
    assert.equal(scoutItems.length, 1);
    assert.equal(scoutItems[0].schedule.timezone, "UTC");
    assert.deepEqual(await listLocalResponsibilities(coworkersDir, "nova"), []);
    const id = scoutItems[0].id;

    // Nova's token cannot see or touch Scout's assignment.
    const novaList = await call(server, nova, "tools/call", { name: "assignments_list", arguments: {} });
    assert.equal(resultText(novaList), "No assignments on this Mac.");
    const novaRemove = await call(server, nova, "tools/call", { name: "assignment_remove", arguments: { id } });
    assert.equal(novaRemove.body.result.isError, true);
    assert.match(resultText(novaRemove), /^Couldn't remove the assignment: I don't have an assignment with that id/);
    assert.equal((await listLocalResponsibilities(coworkersDir, "scout")).length, 1);

    // Guardrails and bad input come back as sentences, not protocol errors.
    const tooOften = await call(server, scout, "tools/call", {
      name: "assignment_create",
      arguments: { name: "Watch", instructions: "Check the page.", schedule: { kind: "cron", expression: "*/15 * * * *" } },
    });
    assert.equal(tooOften.body.result.isError, true);
    assert.equal(resultText(tooOften), "Couldn't create the assignment: Runs on this Mac need at least 1 hour between them; this schedule would run them 15 minutes apart.");
    const cloud = await call(server, scout, "tools/call", {
      name: "assignment_create",
      arguments: { name: "Watch", instructions: "Check the page.", schedule: { kind: "daily", hour: 9, minute: 0 }, placement: "cloud" },
    });
    assert.match(resultText(cloud), /^Couldn't create the assignment: The person is not signed in to OpenWork/);
    const nothing = await call(server, scout, "tools/call", { name: "assignment_update", arguments: { id, patch: {} } });
    assert.match(resultText(nothing), /Say what should change/);
    const unknown = await call(server, scout, "tools/call", { name: "assignment_fly", arguments: {} });
    assert.equal(unknown.body.error.code, -32602);

    const started = await call(server, scout, "tools/call", { name: "assignment_run_now", arguments: { id } });
    assert.equal(resultText(started), 'Started assignment "Move the car" now');
    assert.deepEqual(runs, [{ slug: "scout", id }]);
    // A token the server no longer knows ends that coworker's access.
    tokens.delete(nova);
    assert.equal((await call(server, nova, "tools/call", { name: "assignments_list", arguments: {} })).status, 401);
  } finally {
    await server.stop();
  }
});

test("authenticated self tools persist only the bound coworker's memory and soul and refuse secrets", async () => {
  const fixtureState = await fixture();
  const { coworkersDir } = fixtureState;
  const scout = "scout-token";
  const server = await serve(fixtureState, new Map([[scout, "scout"]]));
  try {
    const remembered = await call(server, scout, "tools/call", { name: "memory_remember", arguments: { text: "You work in Product", kind: "long-term", topic: "About you" } });
    assert.equal(remembered.body.result.isError, false);
    assert.match(await readCoworkerFile(coworkersDir, "scout", "memory/long-term/about-you.md"), /- You work in Product/);
    await assert.rejects(readCoworkerFile(coworkersDir, "nova", "memory/long-term/about-you.md"));
    const soul = await call(server, scout, "tools/call", { name: "soul_update", arguments: { section: "Communication", change: { kind: "add", text: "Keep replies short." } } });
    assert.equal(soul.body.result.isError, false);
    assert.match(await readCoworkerFile(coworkersDir, "scout", "soul.md"), /- Keep replies short\./);
    assert.doesNotMatch(await readCoworkerFile(coworkersDir, "nova", "soul.md"), /Keep replies short/);
    const secret = await call(server, scout, "tools/call", { name: "memory_remember", arguments: { text: "The password is hunter2", kind: "working" } });
    assert.equal(secret.body.result.isError, true);
    assert.match(resultText(secret), /^Couldn't remember that: That looks like a secret or a credential/);
    assert.doesNotMatch(await readCoworkerFile(coworkersDir, "scout", "memory/working.md"), /hunter2/);
    const read = await call(server, scout, "tools/call", { name: "self_read", arguments: { what: "memory" } });
    assert.match(resultText(read), /You work in Product/);
  } finally {
    await server.stop();
  }
});
