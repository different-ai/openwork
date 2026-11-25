// `use_private_values`: private values the agent never sees, used in a program it runs or in one https request.
// One card is asked before anything runs, what is refused stops everything, and nothing returned holds a value.
// The runner and the request are stand-ins that record what they were given.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserSecrets } from "./browser-secrets.mjs";
import { createPrivateValueUse } from "./private-value-use.mjs";
import { requestWithValues, scrubValues } from "./value-use.mjs";

const SESSION = "s1";
// Made up for the test.
const TOKEN = "made-up token/+ &42";
const PASTED = "pasted by hand/+ &77";
const KEY = "made-up session key/+ &==99";
const READ_TOKEN = ["op", "read", "op://Private/Example/token"];
const BW = ["/opt/homebrew/bin/bw", "get", "password", "example.com"];

function world({ flag = true, approve = async () => true, answers = { [READ_TOKEN.join(" ")]: { ok: true, value: TOKEN } }, run, request } = {}) {
  const calls = [];
  const notes = [];
  const asked = [];
  const core = createBrowserSecrets();
  const state = { flag };
  const host = createPrivateValueUse({
    secrets: core,
    enabled: () => state.flag,
    noteValueFill: (sessionId, fill) => notes.push({ sessionId, ...fill }),
    approveValues: async (sessionId, requested) => {
      calls.push("approve");
      asked.push({ sessionId, request: requested });
      const answer = await approve(requested);
      return answer === true ? { approved: true, values: requested.fills.map(() => null), keep: requested.fills.map(() => false) }
        : answer === false ? { approved: false, values: [], keep: [] } : answer;
    },
    runValueCommand: async (command, _signal, unlock) => {
      calls.push(["source", command, unlock]);
      const answer = answers[command.join(" ")] ?? { ok: false, code: "command_not_found" };
      return typeof answer === "function" ? answer(unlock) : answer;
    },
    useWith: {
      run: async (runArgs, values, options) => {
        calls.push(["run", runArgs.command, values, options.cwd]);
        return run ? run(runArgs, values) : { ok: true, exitCode: 0, output: scrubValues(values.map((entry) => entry.value).join("\n"), values.map((entry) => entry.value)), errors: "", truncated: false };
      },
      request: async (requestArgs, values) => {
        calls.push(["request", requestArgs, values]);
        return request ? request(requestArgs, values) : { ok: true, status: 200, headers: {}, body: "{}", truncated: false };
      },
    },
  });
  const use = (args) => host.request({ sessionId: SESSION, args });
  return { calls, notes, asked, core, state, use };
}
const clean = (value) => !JSON.stringify(value).includes(TOKEN) && !JSON.stringify(value).includes(PASTED) && !JSON.stringify(value).includes(KEY);

test("a program runs with a value from a command in its environment, after one card, and what it printed holds no value", async () => {
  const { calls, asked, notes, use } = world();
  const result = await use({ values: [{ name: "GH_TOKEN", command: READ_TOKEN }], run: { command: ["gh", "api", "user"] }, cwd: "/work" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(asked[0].request, { use: { kind: "run", command: ["gh", "api", "user"] }, fills: [{ field: "$GH_TOKEN", command: READ_TOKEN }] });
  assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), ["approve", "source", "run"]);
  assert.deepEqual(calls[2][2], [{ name: "GH_TOKEN", value: TOKEN }]);
  assert.equal(calls[2][3], "/work");
  assert.equal(result.output, "[secret]");
  assert.ok(clean(result));
  assert.deepEqual(notes, [{ sessionId: SESSION, site: "run gh api user", field: "$GH_TOKEN", source: "command", program: "op", result: "filled" }]);
});

test("a request carries a pasted value at its header place, and the card names the method and the URL without its query", async () => {
  const { calls, asked, notes, use } = world({ approve: async () => ({ approved: true, values: [PASTED], keep: [false] }) });
  const result = await use({ values: [{ name: "TOKEN", ask: "Example token" }], request: { method: "GET", url: "https://api.example.com/v1/me?x=1", headers: { Authorization: "Bearer {{TOKEN}}" } } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(asked[0].request, { use: { kind: "request", method: "GET", url: "https://api.example.com/v1/me", origin: "https://api.example.com" }, fills: [{ field: "header Authorization", ask: "Example token" }] });
  assert.deepEqual(calls[1][2], [{ name: "TOKEN", value: PASTED }]);
  assert.equal(notes[0].source, "paste");
  assert.equal(notes[0].site, "GET https://api.example.com/v1/me");
});

test("a no, or the flag off, or a use that is not exactly one, runs nothing and asks nothing more", async () => {
  const declined = world({ approve: async () => false });
  const no = await declined.use({ values: [{ name: "A", command: READ_TOKEN }], run: { command: ["x"] } });
  assert.equal(no.code, "credential_declined");
  assert.deepEqual(declined.calls, ["approve"]);

  const off = world({ flag: false });
  assert.equal((await off.use({ values: [{ name: "A", command: READ_TOKEN }], run: { command: ["x"] } })).code, "values_unavailable");
  assert.deepEqual(off.calls, []);

  const bad = world();
  for (const args of [{}, { values: [{ name: "A", command: READ_TOKEN }] }, { values: [{ name: "PATH", command: READ_TOKEN }], run: { command: ["x"] } },
    { values: [{ name: "A", command: READ_TOKEN }], request: { method: "GET", url: "http://e.com", headers: { H: "{{A}}" } } }]) {
    assert.equal((await bad.use(args)).code, "invalid_use", JSON.stringify(args));
  }
  assert.deepEqual(bad.calls, []);
});

test("an organization's refusal is told as it is, and nothing runs", async () => {
  const refused = world({ approve: async () => ({ approved: false, values: [], keep: [], refused: { code: "value_commands_off", error: "Your organization does not allow this." } }) });
  const result = await refused.use({ values: [{ name: "A", command: READ_TOKEN }], run: { command: ["x"] } });
  assert.deepEqual([result.code, result.error], ["value_commands_off", "Your organization does not allow this."]);
  assert.deepEqual(refused.calls, ["approve"]);
});

test("a source command that fails stops the whole use before the program runs, and says only its exit code and first error line", async () => {
  const failing = world({ answers: { [READ_TOKEN.join(" ")]: { ok: false, code: "command_failed", exitCode: 1, detail: "not signed in" } } });
  const result = await failing.use({ values: [{ name: "A", command: READ_TOKEN }], run: { command: ["x"] } });
  assert.equal(result.code, "command_failed");
  assert.match(result.error, /exit code 1\): not signed in\. Nothing was run or sent\./);
  assert.equal(failing.calls.some((call) => Array.isArray(call) && call[0] === "run"), false);
  assert.deepEqual(failing.notes.map((note) => note.result), ["command_failed"]);
});

test("a command that needs a session key gets the one pasted on the card, and the key is held like any value", async () => {
  const keyed = world({ answers: { [BW.join(" ")]: (unlock) => unlock?.BW_SESSION === KEY ? { ok: true, value: TOKEN } : { ok: false, code: "command_failed", exitCode: 1 } },
    approve: async (requested) => ({ approved: true, values: requested.fills.map((fill) => fill.unlock ? KEY : null), keep: requested.fills.map(() => false) }) });
  const result = await keyed.use({ values: [{ name: "PASS", command: BW, unlock: { env: "BW_SESSION", ask: "Bitwarden session key" }, as: "file" }], run: { command: ["deploy"] } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(keyed.asked[0].request.fills, [{ field: "file in $PASS", command: BW, needs: "BW_SESSION" }, { unlock: "BW_SESSION", program: BW[0], ask: "Bitwarden session key" }]);
  assert.deepEqual(keyed.calls[2][2], [{ name: "PASS", as: "file", value: TOKEN }]);
  assert.equal(keyed.core.redactText(`k ${KEY} v ${TOKEN}`), "k [secret] v [secret]");
});

test("a pasted value kept for the chat is found again by its NAME and program, however the agent words what it asks for", async () => {
  const kept = world({ approve: async (requested) => requested.fills[0].kept ? { approved: true, values: [null], keep: [false] } : { approved: true, values: [PASTED], keep: [true] } });
  const probe = (ask, script, name = "API_KEY", program = "node") => kept.use({ values: [{ name, ask }], run: { command: [program, script] } });
  assert.equal((await probe("Example API key", "first.mjs")).ok, true);
  assert.equal((await probe("Example API key (same as before)", "second.mjs")).ok, true);
  assert.equal((await probe("Example API key", "third.mjs", "OTHER_KEY")).ok, true);
  assert.equal((await probe("Example API key", "fourth.py", "API_KEY", "python3")).ok, true);
  assert.deepEqual(kept.asked.map((card) => card.request.fills[0].kept === true), [false, true, false, false]);
  assert.deepEqual(kept.notes.map((note) => note.source), ["paste", "kept", "paste", "paste"]);
  assert.deepEqual(kept.core.listKept(SESSION), [{ site: "run:node", label: "API_KEY" }, { site: "run:node", label: "OTHER_KEY" }, { site: "run:python3", label: "API_KEY" }]);
  assert.deepEqual(kept.calls.filter((call) => call[0] === "run").map((call) => call[2][0].value), [PASTED, PASTED, PASTED, PASTED]);
});

test("a value too short to tell apart from ordinary text is never used", async () => {
  const short = world({ answers: { [READ_TOKEN.join(" ")]: { ok: true, value: "abc" } } });
  assert.equal((await short.use({ values: [{ name: "A", command: READ_TOKEN }], run: { command: ["x"] } })).code, "value_unusable");
  assert.equal(short.calls.some((call) => Array.isArray(call) && call[0] === "run"), false);
});

const ISSUED = "issued access token/+ &55";
/** A token endpoint that answers with `answer` as JSON, sent through the real request runner. */
const tokenEndpoint = (answer) => (requestArgs, values) => requestWithValues(requestArgs, values, {
  fetch: async () => new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } }) });

test("a token a request's answer holds is sealed: kept for the chat, never returned, and sent later only to its origin after a card", async () => {
  const sealing = world({ request: tokenEndpoint({ access_token: ISSUED, token_type: "bearer", note: `again ${ISSUED}` }) });
  const first = await sealing.use({ values: [{ name: "SECRET", command: READ_TOKEN }],
    request: { method: "POST", url: "https://auth.example.com/token", body: "client_secret={{SECRET}}", seal: [{ name: "API_TOKEN", from: "access_token", for: "https://api.example.com" }] } });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(sealing.asked[0].request.use.seal, [{ name: "API_TOKEN", from: "access_token", for: "https://api.example.com" }]);
  assert.ok(!JSON.stringify(first).includes(ISSUED));
  assert.equal(JSON.parse(first.body).token_type, "bearer");
  assert.deepEqual(first.sealed, [{ name: "API_TOKEN", for: "https://api.example.com", kept: true }]);
  assert.equal("held" in first, false);
  assert.equal(sealing.core.redactText(`x ${ISSUED}`), "x [secret]");

  const second = await sealing.use({ values: [{ name: "T", ask: "API_TOKEN" }], request: { method: "GET", url: "https://api.example.com/me", headers: { Authorization: "Bearer {{T}}" } } });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(sealing.asked[1].request.fills, [{ field: "header Authorization", ask: "API_TOKEN", kept: true }]);
  assert.deepEqual(sealing.calls.at(-1)[2], [{ name: "T", value: ISSUED }]);

  const elsewhere = await sealing.use({ values: [{ name: "T", ask: "API_TOKEN" }], request: { method: "GET", url: "https://evil.example.net/me", headers: { Authorization: "Bearer {{T}}" } } });
  assert.deepEqual(sealing.asked[2].request.fills, [{ field: "header Authorization", ask: "API_TOKEN" }]);
  assert.equal(elsewhere.code, "credential_declined");
});

test("a seal whose path holds no string withholds the whole answer and keeps nothing", async () => {
  const sealing = world({ request: tokenEndpoint({ token: { value: ISSUED } }) });
  const result = await sealing.use({ values: [{ name: "SECRET", command: READ_TOKEN }],
    request: { method: "POST", url: "https://auth.example.com/token", body: "{{SECRET}}", seal: [{ name: "API_TOKEN", from: "access_token" }] } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.body, "");
  assert.deepEqual(result.sealed, [{ name: "API_TOKEN", for: "https://auth.example.com", kept: false }]);
  assert.match(result.next, /withheld/);
  assert.deepEqual(sealing.core.listKept(SESSION), []);
});

test("a seal named like a value, or for a site that is not https, is refused before anything runs", async () => {
  const bad = world();
  for (const seal of [[{ name: "SECRET", from: "a" }], [{ name: "X", from: "a", for: "http://api.example.com" }], [{ name: "X", from: "a b" }], []]) {
    const args = { values: [{ name: "SECRET", command: READ_TOKEN }], request: { method: "POST", url: "https://auth.example.com/t", body: "{{SECRET}}", seal } };
    assert.equal((await bad.use(args)).code, "invalid_use", JSON.stringify(seal));
  }
  assert.deepEqual(bad.calls, []);
});

test("a run that fails to start, or a request that gets no answer, says so and is noted with its code", async () => {
  const missing = world({ run: async () => ({ ok: false, code: "command_not_found" }) });
  assert.equal((await missing.use({ values: [{ name: "A", command: READ_TOKEN }], run: { command: ["nope"] } })).code, "command_not_found");
  assert.deepEqual(missing.notes.map((note) => note.result), ["command_not_found"]);
  const lost = world({ request: async () => ({ ok: false, code: "request_failed" }) });
  const result = await lost.use({ values: [{ name: "A", command: READ_TOKEN }], request: { method: "POST", url: "https://e.example/x", body: "{{A}}" } });
  assert.equal(result.code, "request_failed");
  assert.ok(clean(result));
});
