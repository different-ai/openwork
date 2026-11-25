// Who decides a private-value fill before the card: the organization's rules, then the person's own switches.
// Nothing here can fill a field without the card, and no value is ever in what Settings lists.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPrivateValues, createPrivateValueSourceStore, createPrivateValueSwitchStore, privateValueCommandLines, privateValueProgramName, privateValueReport } from "./private-values.mjs";

const SITE = "https://app.example";
const BW = { field: "password", command: ["/opt/homebrew/bin/bw", "get", "password", "example.com"] };
const OP = { field: "password", command: ["op", "read", "op://Private/Example/password"] };
const ASKED = { field: "text", ask: "Account number" };
const LOCKED = { ...BW, needs: "BW_SESSION" };
const KEY = { unlock: "BW_SESSION", program: "/opt/homebrew/bin/bw", ask: "Bitwarden session key" };
const YES = { approved: true, values: [null], keep: [false] };
const rule = (action, effect, resource = "*", source = "Everyone") => ({ action, resource, effect, source });

test("reports only fill metadata, with a program basename and no session ID or private value", () => {
  const id = "fixture-fill-id";
  const record = { at: 0, sessionId: "chat", site: SITE, field: "password", source: "command", program: BW.command[0], result: "filled", value: "fixture-private-value" };
  const expected = { id, at: "1970-01-01T00:00:00.000Z", site: SITE, field: "password", source: "command", program: "bw", result: "filled" };
  assert.deepEqual(privateValueReport(record, id), expected);
  assert.deepEqual(privateValueReport({ ...record, result: "blocked", program: "C:\\Tools\\bw.exe" }, id), { ...expected, result: "refused", program: "bw.exe" });
  const { program, ...withoutProgram } = expected;
  assert.deepEqual(privateValueReport({ ...record, source: "paste", program: undefined, result: "declined" }, id), { ...withoutProgram, source: "paste", result: "declined" });
  assert.equal(privateValueReport({ ...record, result: "off" }, id), null);
});

function host({ rules = [], enabled = true, own = {}, answer = YES } = {}) {
  const state = { policy: /** @type {unknown} */ ({ enabled, rules }), switches: { commands: true, paste: true, keep: true, ...own }, clock: 0,
    asked: [], records: [], grants: [{ id: "g1", sessionId: "chat", site: SITE, field: "password", command: BW.command }],
    kept: [{ sessionId: "chat", site: SITE, label: "Account number" }, { sessionId: "chat", site: "command:/opt/homebrew/bin/bw", label: "Bitwarden session key" }],
    answer: /** @type {unknown} */ (answer), reads: 0, onAsk: /** @type {(() => void) | null} */ (null) };
  const values = createPrivateValues({
    readPolicy: async () => { state.reads++; if (state.policy instanceof Error) throw state.policy; return state.policy; },
    switches: { read: async () => ({ ...state.switches }), write: async (next) => { state.switches = { ...next }; } },
    approveValues: async (sessionId, request) => { state.asked.push({ sessionId, ...request }); state.onAsk?.(); return state.answer; },
    grants: { list: () => state.grants, remove: (id) => { const before = state.grants.length; state.grants = id === undefined ? [] : state.grants.filter((grant) => grant.id !== id); return id === undefined || state.grants.length < before; } },
    secrets: {
      listAllKept: () => state.kept,
      forgetAllKept: () => { state.kept = []; },
      forget: (entry) => { const before = state.kept.length; state.kept = state.kept.filter((kept) => !(kept.sessionId === entry.sessionId && kept.site === entry.site && kept.label === entry.label)); return state.kept.length < before; },
    },
    onRecord: (record) => state.records.push(record),
    now: () => state.clock,
    policyMs: 1_000,
  });
  const approve = (fills, site = SITE) => values.approve("chat", { site, fills }, new AbortController().signal);
  return { values, state, approve };
}

test("with nothing set, the card is asked with nothing narrowed, and its answer is the answer", async () => {
  const { approve, state, values } = host();
  assert.equal(await values.enabled(), true);
  assert.deepEqual(await approve([BW]), YES);
  assert.deepEqual(state.asked, [{ sessionId: "chat", site: SITE, fills: [BW], limits: { everyTime: false, paste: true, keep: true } }]);
  assert.deepEqual(state.records, []);
});

test("anything but a confirmed yes with its rules is off: nothing is asked and nothing is listed", async () => {
  for (const policy of [{ enabled: false, rules: [] }, { enabled: true }, { enabled: "true", rules: [] }, null, new Error("offline")]) {
    const { approve, state, values } = host();
    state.policy = policy;
    assert.equal(await values.enabled(), false);
    assert.deepEqual(await approve([BW]), { approved: false, values: [], keep: [] });
    assert.deepEqual(state.asked, []);
    assert.deepEqual(await values.list(), { enabled: false, switches: { commands: true, paste: true, keep: true }, organization: { fills: null, commands: null, paste: null }, always: [], kept: [], recent: [] });
  }
});

test("every program named as a source is kept out of the agent's own terminal only while the organization's block is confirmed", async () => {
  const blocked = host({ rules: [rule("private_value_terminal", "deny")] });
  assert.deepEqual(await blocked.values.terminal(), { blocked: true, source: "Everyone", programs: [] });
  await blocked.approve([BW, { field: "token", command: ["C:\\Tools\\vault-cli.exe", "read", "prod"] }]);
  assert.deepEqual(await blocked.values.terminal(), { blocked: true, source: "Everyone", programs: ["bw", "vault-cli"] });
  const declined = host({ rules: [rule("private_value_terminal", "deny", "*", "Finance")], answer: { approved: false, values: [], keep: [] } });
  await declined.approve([OP]);
  assert.deepEqual(await declined.values.terminal(), { blocked: true, source: "Finance", programs: ["op"] });
  assert.deepEqual(await host({ rules: [rule("private_value_terminal", "allow")] }).values.terminal(), { blocked: false });
  assert.deepEqual(await host({ rules: [] }).values.terminal(), { blocked: false });
  assert.deepEqual(await host({ enabled: false, rules: [rule("private_value_terminal", "deny")] }).values.terminal(), { blocked: false });
  const offline = host({ rules: [rule("private_value_terminal", "deny")] });
  offline.state.policy = new Error("offline");
  assert.deepEqual(await offline.values.terminal(), { blocked: false });
});

test("the programs named as sources outlive a restart, by file name only", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pv-sources-"));
  const file = path.join(dir, "sources.json");
  await createPrivateValueSourceStore({ file }).add(["bw", "vault-cli", "bw"]);
  assert.deepEqual(await createPrivateValueSourceStore({ file }).list(), ["bw", "vault-cli"]);
  assert.equal(privateValueProgramName("/opt/homebrew/bin/bw"), "bw");
  assert.equal(privateValueProgramName("C:\\Tools\\vault-cli.EXE"), "vault-cli");
  await rm(dir, { recursive: true, force: true });
});

test("the organization's answer is read again after its time, and a rollout that turns off stops fills", async () => {
  const { approve, state, values } = host();
  assert.equal((await approve([BW])).approved, true);
  state.policy = { enabled: false, rules: [] };
  state.clock = 999;
  assert.equal(await values.enabled(), true);
  state.clock = 1_000;
  assert.equal((await approve([BW])).approved, false);
  assert.equal(state.asked.length, 1);
});

test("a blocked website is refused before the card, in words that name who blocked it", async () => {
  const { approve, state } = host({ rules: [rule("private_value_fill", "deny"), rule("private_value_fill", "allow", "*.example.com")] });
  const refused = await approve([BW]);
  assert.equal(refused.approved, false);
  assert.equal(refused.refused?.code, "values_blocked");
  assert.match(refused.refused?.error ?? "", /Everyone/);
  assert.match(refused.refused?.error ?? "", /Nothing was run or typed/);
  assert.deepEqual(state.asked, []);
  assert.deepEqual(state.records.map((record) => [record.site, record.field, record.source, record.program, record.result]), [[SITE, "password", "command", "/opt/homebrew/bin/bw", "blocked"]]);
  assert.equal((await approve([BW], "https://login.example.com")).approved, true);
});

test("the organization's Ask first asks every time: the card offers no Always", async () => {
  const { approve, state } = host({ rules: [rule("private_value_fill", "ask")] });
  await approve([BW]);
  assert.equal(state.asked[0].limits.everyTime, true);
});

test("a command rule covers the program by name or by path, and a blocked command wins over an allowed one", async () => {
  assert.deepEqual(privateValueCommandLines(BW.command), ["/opt/homebrew/bin/bw get password example.com", "bw get password example.com"]);
  assert.deepEqual(privateValueCommandLines(OP.command), ["op read op://Private/Example/password"]);
  const only = host({ rules: [rule("private_value_command", "deny"), rule("private_value_command", "allow", "bw get *"), rule("private_value_command", "deny", "bw get notes *")] });
  assert.equal((await only.approve([BW])).approved, true);
  const other = await only.approve([OP]);
  assert.equal(other.refused?.code, "value_command_blocked");
  assert.match(other.refused?.error ?? "", /Use fill_from with ask instead of command/);
  assert.equal((await only.approve([{ field: "textarea", command: ["/opt/homebrew/bin/bw", "get", "notes", "example.com"] }])).refused?.code, "value_command_blocked");
  assert.equal((await only.approve([BW, OP])).refused?.code, "value_command_blocked");
  assert.equal(only.state.asked.length, 1);

  const blocked = host({ rules: [rule("private_value_command", "deny", "bw *")] });
  assert.equal((await blocked.approve([BW])).refused?.code, "value_command_blocked");
  assert.equal((await blocked.approve([OP])).approved, true);
  const pinned = host({ rules: [rule("private_value_command", "deny"), rule("private_value_command", "allow", "/opt/homebrew/bin/bw *")] });
  assert.equal((await pinned.approve([BW])).approved, true);
  assert.equal((await pinned.approve([{ field: "password", command: ["/tmp/bw", "get", "password", "x"] }])).refused?.code, "value_command_blocked");
});

test("pasting blocked by the organization refuses a pasted value and a pasted key, narrows the card, and lets go of what was kept", async () => {
  const { approve, state } = host({ rules: [rule("private_value_paste", "deny")] });
  const pasted = await approve([ASKED]);
  assert.equal(pasted.refused?.code, "value_paste_blocked");
  assert.match(pasted.refused?.error ?? "", /A value can still come from a command/);
  const keyed = await approve([LOCKED, KEY]);
  assert.equal(keyed.refused?.code, "value_paste_blocked");
  assert.match(keyed.refused?.error ?? "", /needs a key the person would paste/);
  assert.deepEqual(state.kept, []);
  assert.deepEqual(state.asked, []);
  assert.equal((await approve([BW])).approved, true);
  assert.deepEqual(state.asked[0].limits, { everyTime: false, paste: false, keep: true });
  assert.doesNotMatch((await host({ rules: [rule("private_value_paste", "deny"), rule("private_value_command", "deny", "op *")] }).approve([OP])).refused?.error ?? "", /with ask instead/);
});

test("the person's own switches refuse the same way, after the organization's rules", async () => {
  const off = host({ own: { commands: false, paste: false, keep: false } });
  assert.equal((await off.approve([BW])).refused?.code, "value_commands_off");
  assert.equal((await off.approve([ASKED])).refused?.code, "value_paste_off");
  assert.deepEqual(off.state.records.map((record) => record.result), ["off", "off"]);
  const both = host({ own: { commands: false }, rules: [rule("private_value_command", "deny", "bw *")] });
  assert.equal((await both.approve([BW])).refused?.code, "value_command_blocked");
  const noKeep = host({ own: { keep: false } });
  await noKeep.approve([ASKED]);
  assert.deepEqual(noKeep.state.asked[0].limits, { everyTime: false, paste: true, keep: false });
});

test("a no on the card is a plain no, and a rule or switch that changed while the card was open still refuses", async () => {
  const declined = host({ answer: { approved: false, values: [], keep: [] } });
  assert.deepEqual(await declined.approve([BW]), { approved: false, values: [], keep: [] });
  assert.deepEqual(declined.state.records.map((record) => record.result), ["declined"]);

  const changed = host({ answer: { approved: true, values: ["made-up-value"], keep: [true] } });
  changed.state.onAsk = () => { changed.state.switches.paste = false; };
  const answer = await changed.approve([ASKED]);
  assert.deepEqual([answer.approved, answer.values, answer.refused?.code], [false, [], "value_paste_off"]);

  const blocked = host();
  blocked.state.onAsk = () => { blocked.state.policy = { enabled: true, rules: [rule("private_value_fill", "deny")] }; blocked.state.clock = 5_000; };
  assert.equal((await blocked.approve([BW])).refused?.code, "values_blocked");
});

test("Settings lists the switches, what the organization set, every Always, what is kept and the recent fills, never a value", async () => {
  const { values, state } = host({ rules: [rule("private_value_fill", "ask"), rule("private_value_command", "deny", "op *"), rule("private_value_paste", "deny")] });
  values.note("chat", { site: SITE, field: "password", source: "command", program: "/opt/homebrew/bin/bw", result: "filled" });
  values.note("chat", { site: SITE, field: "text", source: "paste", result: "value_mismatch", value: "made-up-value" });
  values.note("chat", { site: 4, field: "text", source: "paste", result: "filled" });
  const listed = await values.list();
  assert.deepEqual(listed.organization, { fills: "ask", commands: "limited", paste: "blocked" });
  assert.deepEqual(listed.switches, { commands: true, paste: true, keep: true });
  assert.deepEqual(listed.always, [{ id: "g1", sessionId: "chat", site: SITE, field: "password", command: "/opt/homebrew/bin/bw get password example.com", blocked: false }]);
  assert.deepEqual(listed.kept, []);
  assert.deepEqual(listed.recent.map((record) => [record.field, record.source, record.program, record.result]), [["text", "paste", undefined, "value_mismatch"], ["password", "command", "/opt/homebrew/bin/bw", "filled"]]);
  assert.doesNotMatch(JSON.stringify(listed), /made-up-value/);
  assert.deepEqual(state.records.length, 2);

  assert.deepEqual((await host({ rules: [rule("private_value_fill", "deny"), rule("private_value_command", "deny")] }).values.list()).organization, { fills: "blocked", commands: "blocked", paste: null });
  const limited = await host({ rules: [rule("private_value_fill", "deny"), rule("private_value_fill", "allow", "*.example.com"), rule("private_value_command", "deny"), rule("private_value_command", "allow", "op *")] }).values.list();
  assert.deepEqual(limited.organization, { fills: "limited", commands: "limited", paste: null });
  assert.equal(limited.always[0].blocked, true);

  const kept = await host().values.list();
  assert.deepEqual(kept.kept.map((entry) => [entry.site, entry.program, entry.label]), [[SITE, undefined, "Account number"], [undefined, "/opt/homebrew/bin/bw", "Bitwarden session key"]]);
});

test("only the fifty most recent fills are listed", async () => {
  const { values } = host();
  for (let index = 0; index < 60; index++) values.note("chat", { site: SITE, field: `f${index}`, source: "command", result: "filled" });
  const { recent } = await values.list();
  assert.deepEqual([recent.length, recent[0].field, recent.at(-1).field], [50, "f59", "f10"]);
});

test("turning a switch off lets go of what it allowed, and one Always or one kept value can be removed", async () => {
  const { values, state } = host();
  const [, key] = (await values.list()).kept;
  assert.deepEqual(values.remove("kept", key.id), { ok: true });
  assert.deepEqual(state.kept.map((entry) => entry.label), ["Account number"]);
  assert.deepEqual(values.remove("kept", key.id), { ok: false });
  assert.deepEqual(values.remove("kept", "not json"), { ok: false });
  assert.deepEqual(values.remove("other", "g1"), { ok: false });
  assert.deepEqual(await values.setSwitch("everything", false), { ok: false });
  assert.deepEqual(await values.setSwitch("keep", "no"), { ok: false });
  assert.deepEqual(await values.setSwitch("keep", false), { ok: true });
  assert.deepEqual([state.switches.keep, state.kept, state.grants.length], [false, [], 1]);
  assert.deepEqual(values.remove("always", "g1"), { ok: true });
  state.grants = [{ id: "g2", sessionId: "chat", site: SITE, field: "password", command: OP.command }];
  assert.deepEqual(await values.setSwitch("commands", false), { ok: true });
  assert.deepEqual([state.switches.commands, state.grants], [false, []]);
});

test("the switches are kept in one file, and only an explicit off is off", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "private-values-"));
  try {
    const file = path.join(folder, "private-values.json");
    assert.deepEqual(await createPrivateValueSwitchStore({ file }).read(), { commands: true, paste: true, keep: true });
    const store = createPrivateValueSwitchStore({ file });
    await store.write({ commands: false, paste: true, keep: true });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { commands: false, paste: true, keep: true });
    assert.deepEqual(await createPrivateValueSwitchStore({ file }).read(), { commands: false, paste: true, keep: true });
    await writeFile(file, JSON.stringify({ commands: 0, paste: "false", keep: false, extra: true }));
    assert.deepEqual(await createPrivateValueSwitchStore({ file }).read(), { commands: true, paste: true, keep: false });
    await writeFile(file, "{not json");
    assert.deepEqual(await createPrivateValueSwitchStore({ file }).read(), { commands: true, paste: true, keep: true });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a value used outside a page is ruled by the request's site, or by the program it is given to, and is listed by that use", async () => {
  const sinkFill = { field: "$GH_TOKEN", command: OP.command };
  const run = { kind: "run", command: ["gh", "api", "user"] };
  const use = (values, target, fills = [sinkFill]) => values.approve("chat", { use: target, fills }, new AbortController().signal);

  const allowed = host();
  assert.deepEqual(await use(allowed.values, run), YES);
  assert.deepEqual(allowed.state.asked[0], { sessionId: "chat", use: run, fills: [sinkFill], limits: { everyTime: false, paste: true, keep: true } });

  const blockedRun = host({ rules: [rule("private_value_run", "deny", "gh *")] });
  const refused = await use(blockedRun.values, run);
  assert.equal(refused.refused?.code, "value_run_blocked");
  assert.deepEqual(blockedRun.state.asked, []);
  assert.deepEqual(blockedRun.state.records.map((record) => [record.site, record.field, record.result]), [["run gh api user", "$GH_TOKEN", "blocked"]]);

  const askedRun = host({ rules: [rule("private_value_run", "ask", "gh *")] });
  await use(askedRun.values, run);
  assert.equal(askedRun.state.asked[0].limits.everyTime, true);

  const request = { kind: "request", method: "GET", url: "https://api.example/v1/me", origin: "https://api.example" };
  const blockedSite = host({ rules: [rule("private_value_fill", "deny", "https://api.example")] });
  assert.equal((await use(blockedSite.values, request, [{ field: "header Authorization", ask: "Example token" }])).refused?.code, "values_blocked");
  assert.deepEqual(blockedSite.state.records.map((record) => record.site), ["GET https://api.example/v1/me"]);
  const otherSite = host({ rules: [rule("private_value_fill", "deny", "https://other.example")] });
  assert.deepEqual(await use(otherSite.values, request, [{ field: "header Authorization", ask: "Example token" }]), YES);
});

test("a request that seals a value from its answer is refused when keeping is off, or when the organization blocks the site it is kept for", async () => {
  const fills = [{ field: "request body", command: OP.command }];
  const sealing = { kind: "request", method: "POST", url: "https://auth.example/token", origin: "https://auth.example", seal: [{ name: "API_TOKEN", from: "access_token", for: "https://api.example" }] };
  const use = (values) => values.approve("chat", { use: sealing, fills }, new AbortController().signal);

  assert.deepEqual(await use(host().values), YES);
  const keepOff = host({ own: { keep: false } });
  assert.equal((await use(keepOff.values)).refused?.code, "value_keep_off");
  assert.deepEqual(keepOff.state.asked, []);
  const blockedFor = host({ rules: [rule("private_value_fill", "deny", "https://api.example")] });
  const refused = await use(blockedFor.values);
  assert.equal(refused.refused?.code, "values_blocked");
  assert.match(refused.refused?.error ?? "", /API_TOKEN cannot be kept/);
  assert.deepEqual(blockedFor.state.asked, []);
});
