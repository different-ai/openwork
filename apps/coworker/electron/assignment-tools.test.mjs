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
        return { accepted: true, queued: runs.length > 1, reason: "" };
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

test("every tool takes the coworker from its token, never from the model", async () => {
  const { tools } = await fixture();
  assert.deepEqual(tools.map((tool) => tool.name), ["assignments_list", "assignment_create", "assignment_update", "assignment_run_now", "assignment_remove", "memory_remember", "memory_forget", "memory_note", "soul_update", "self_read"]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(Object.hasOwn(tool.inputSchema.properties ?? {}, "slug"), false, `${tool.name} must not take a coworker`);
  }
});

test("assignment tools answer for the bound coworker only, in plain words with ids", async () => {
  const fixtureState = await fixture();
  const { coworkersDir, runs } = fixtureState;
  const scout = "scout-token";
  const nova = "nova-token";
  const tokens = new Map([[scout, "scout"], [nova, "nova"]]);
  const server = await serve(fixtureState, tokens);
  try {
    assert.equal((await fetch(server.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rpc("tools/list")) })).status, 401);
    const catalog = await call(server, scout, "tools/list");
    assert.ok(catalog.body.result.tools.some((tool) => tool.name === "assignment_create"));

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
    const createdText = resultText(created);
    assert.match(createdText, /^Created assignment "Move the car" · Every weekday at 9:00 AM(?: \(UTC\))?\n/);
    assert.match(createdText, /Next run: /);
    assert.match(createdText, /Runs on this Mac, only while Open Coworker is open\./);
    const scoutItems = await listLocalResponsibilities(coworkersDir, "scout");
    assert.equal(scoutItems.length, 1);
    assert.equal(scoutItems[0].schedule.timezone, "UTC");
    assert.deepEqual(await listLocalResponsibilities(coworkersDir, "nova"), []);
    const id = scoutItems[0].id;
    assert.match(createdText, new RegExp(`Id: ${id}$`));

    // Nova's token cannot see or touch Scout's assignment.
    const novaList = await call(server, nova, "tools/call", { name: "assignments_list", arguments: {} });
    assert.equal(resultText(novaList), "No assignments on this Mac.");
    const novaRemove = await call(server, nova, "tools/call", { name: "assignment_remove", arguments: { id } });
    assert.equal(novaRemove.body.result.isError, true);
    assert.match(resultText(novaRemove), /^Couldn't remove the assignment: I don't have an assignment with that id/);
    assert.equal((await listLocalResponsibilities(coworkersDir, "scout")).length, 1);

    const listed = await call(server, scout, "tools/call", { name: "assignments_list", arguments: {} });
    assert.match(resultText(listed), new RegExp(`^1 assignment on this Mac:\\n- Move the car \\(id ${id}\\) · Every weekday at 9:00 AM(?: \\(UTC\\))? · Next: `));

    const changed = await call(server, scout, "tools/call", {
      name: "assignment_update",
      arguments: { id, patch: { schedule: { kind: "interval", everyMinutes: 120, from: "09:00", until: "18:00" } } },
    });
    assert.match(resultText(changed), /^Changed assignment "Move the car" · Every 2 hours between 9:00 AM and 6:00 PM, up to 4 times a day/);
    const paused = await call(server, scout, "tools/call", { name: "assignment_update", arguments: { id, patch: { active: false } } });
    assert.match(resultText(paused), /^Paused assignment "Move the car"\nFuture scheduled runs are paused/);
    assert.match(resultText(paused), /queued or running run can still finish/);
    const renamed = await call(server, scout, "tools/call", { name: "assignment_update", arguments: { id, patch: { name: "Car day", active: true } } });
    assert.match(resultText(renamed), /^Resumed assignment "Car day"/);
    const onlyName = await call(server, scout, "tools/call", { name: "assignment_update", arguments: { id, patch: { name: "Move the car" } } });
    assert.match(resultText(onlyName), /^Renamed assignment "Car day" to "Move the car"/);

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
    const queued = await call(server, scout, "tools/call", { name: "assignment_run_now", arguments: { id } });
    assert.match(resultText(queued), /waits its turn/);

    const removed = await call(server, scout, "tools/call", { name: "assignment_remove", arguments: { id } });
    assert.equal(resultText(removed), 'Removed assignment "Move the car"');
    assert.deepEqual(await listLocalResponsibilities(coworkersDir, "scout"), []);

    // A token the server no longer knows ends that coworker's access.
    tokens.delete(nova);
    assert.equal((await call(server, nova, "tools/call", { name: "assignments_list", arguments: {} })).status, 401);
  } finally {
    await server.stop();
  }
});

test("the self tools write the bound coworker's memory and soul and refuse secrets with a sentence", async () => {
  const fixtureState = await fixture();
  const { coworkersDir } = fixtureState;
  const scout = "scout-token";
  const server = await serve(fixtureState, new Map([[scout, "scout"]]));
  try {
    const remembered = await call(server, scout, "tools/call", { name: "memory_remember", arguments: { text: "You work in Product", kind: "long-term", topic: "About you" } });
    assert.equal(resultText(remembered), "Remembered in long-term memory (About you): You work in Product");
    assert.match(await readCoworkerFile(coworkersDir, "scout", "memory/long-term/about-you.md"), /- You work in Product/);
    await assert.rejects(readCoworkerFile(coworkersDir, "nova", "memory/long-term/about-you.md"));
    const working = await call(server, scout, "tools/call", { name: "memory_remember", arguments: { text: "The brief is due Friday", kind: "working" } });
    assert.match(resultText(working), /^Remembered in working memory: The brief is due Friday/);
    const soul = await call(server, scout, "tools/call", { name: "soul_update", arguments: { section: "Communication", change: { kind: "add", text: "Keep replies short." } } });
    assert.equal(resultText(soul), 'Updated Communication: added "Keep replies short."');
    assert.match(await readCoworkerFile(coworkersDir, "scout", "soul.md"), /- Keep replies short\./);
    const secret = await call(server, scout, "tools/call", { name: "memory_remember", arguments: { text: "The password is hunter2", kind: "working" } });
    assert.equal(secret.body.result.isError, true);
    assert.match(resultText(secret), /^Couldn't remember that: That looks like a secret or a credential/);
    assert.doesNotMatch(await readCoworkerFile(coworkersDir, "scout", "memory/working.md"), /hunter2/);
    // A progress note is one line under Now that the same work name replaces and an empty text clears.
    const noted = await call(server, scout, "tools/call", { name: "memory_note", arguments: { work: "Vendor comparison", text: "Reading the three contracts; next: call Beta." } });
    assert.match(resultText(noted), /^Noted for Vendor comparison: Reading the three contracts; next: call Beta\./);
    assert.match(await readCoworkerFile(coworkersDir, "scout", "memory/working.md"), /- \*\*Vendor comparison\*\* — Reading the three contracts; next: call Beta\./);
    const read = await call(server, scout, "tools/call", { name: "self_read", arguments: { what: "memory" } });
    assert.match(resultText(read), /You work in Product/);
    assert.match(resultText(read), /The brief is due Friday/);
    assert.match(resultText(read), /\*\*Vendor comparison\*\* — Reading the three contracts/);
    const renoted = await call(server, scout, "tools/call", { name: "memory_note", arguments: { work: "Vendor comparison", text: "Beta called; Acme is the pick." } });
    assert.match(resultText(renoted), /^Noted for Vendor comparison: Beta called; Acme is the pick\./);
    assert.equal(((await readCoworkerFile(coworkersDir, "scout", "memory/working.md")).match(/Vendor comparison/g) ?? []).length, 1);
    const clearedNote = await call(server, scout, "tools/call", { name: "memory_note", arguments: { work: "Vendor comparison" } });
    assert.match(resultText(clearedNote), /^Cleared the note for Vendor comparison/);
    assert.doesNotMatch(await readCoworkerFile(coworkersDir, "scout", "memory/working.md"), /Vendor comparison/);
    const badNote = await call(server, scout, "tools/call", { name: "memory_note", arguments: { work: "", text: "x" } });
    assert.equal(badNote.body.result.isError, true);
    assert.match(resultText(badNote), /^Couldn't note where the work stands: Say which piece of work/);
    const forgot = await call(server, scout, "tools/call", { name: "memory_forget", arguments: { target: "brief is due" } });
    assert.equal(resultText(forgot), "Forgot from working memory: The brief is due Friday");
    const missing = await call(server, scout, "tools/call", { name: "memory_forget", arguments: { target: "the moon" } });
    assert.match(resultText(missing), /^Couldn't forget that: I couldn't find anything in memory about "the moon"\./);
  } finally {
    await server.stop();
  }
});
