// Approval of fields filled with values the agent never sees: one card for every field of a call, each command
// shown whole and each pasted value taken from the card alone, and an "always" that covers exactly the same
// command into the same kind of field on the same site, never anything pasted.
import assert from "node:assert/strict";
import { test } from "node:test";

import { COMPUTER_PROTOCOL, createComputerControl } from "./computer-control.mjs";

const SITE = "https://app.example";
const PASSWORD = { field: "password", command: ["op", "read", "op://Private/Example/password"] };
const CODE = { field: "number", command: ["/opt/homebrew/bin/bw", "get", "totp", "example.com"] };
const ASKED = { field: "password", ask: "Example password" };
// A command that reads its session key from the environment, and the row that asks the person for that key.
const LOCKED = { field: "password", command: ["/opt/homebrew/bin/bw", "get", "password", "example.com"], needs: "BW_SESSION" };
const KEY = { unlock: "BW_SESSION", program: "/opt/homebrew/bin/bw", ask: "Bitwarden session key" };
const NO = { approved: false, values: [], keep: [] };
const yes = (values = [null], keep = values.map(() => false)) => ({ approved: true, values, keep });

function broker() {
  /** @type {Array<{ sessionId: string, request: import("./computer-control.mjs").ComputerRequest | null }>} */
  const shown = [];
  const control = createComputerControl({
    adapters: [{ id: "local", label: "This computer", placement: "local", protocol: COMPUTER_PROTOCOL,
      readiness: async () => ({ readiness: "ready", detail: "" }), connect: async () => { throw new Error("No app is opened in this test."); } }],
    onRequest: (sessionId, request) => { shown.push({ sessionId, request }); },
  });
  /** Starts an approval and resolves with the card it raised, once it is on screen. */
  const ask = async (input) => {
    const before = shown.length;
    const answer = "fills" in input ? control.approveValues(input) : control.approveCredential(input);
    for (let turn = 0; turn < 50 && shown.length === before; turn++) await new Promise((resolve) => setImmediate(resolve));
    return { answer, request: shown.at(-1)?.request ?? null, raised: shown.length > before };
  };
  return { control, shown, ask };
}

test("the card lists every command with its field and the exact site, and may be made standing", async () => {
  const { control, ask } = broker();
  const { answer, request } = await ask({ sessionId: "chat", site: SITE, fills: [PASSWORD, CODE] });
  assert.equal(request?.reason, "credential");
  assert.equal(request?.standing, undefined);
  assert.deepEqual(request?.credential, { site: SITE, fills: [PASSWORD, CODE] });
  await control.answerRequest({ sessionId: "chat", answer: "allow", id: request.id });
  assert.deepEqual(await answer, yes([null, null]));
});

test("declining answers no, and allowing once asks again the next time", async () => {
  const { control, ask } = broker();
  const first = await ask({ sessionId: "chat", site: SITE, fills: [PASSWORD] });
  await control.answerRequest({ sessionId: "chat", answer: "dismiss", id: first.request.id });
  assert.deepEqual(await first.answer, NO);
  const second = await ask({ sessionId: "chat", site: SITE, fills: [PASSWORD] });
  await control.answerRequest({ sessionId: "chat", answer: "allow", id: second.request.id });
  assert.deepEqual(await second.answer, yes());
  const third = await ask({ sessionId: "chat", site: SITE, fills: [PASSWORD] });
  assert.equal(third.raised, true);
  await control.answerRequest({ sessionId: "chat", answer: "dismiss", id: third.request.id });
  assert.deepEqual(await third.answer, NO);
});

test("always covers exactly the same command into the same kind of field on the same site, in this chat", async () => {
  const { control, ask } = broker();
  const first = await ask({ sessionId: "chat", site: SITE, fills: [PASSWORD, CODE] });
  await control.answerRequest({ sessionId: "chat", answer: "always", id: first.request.id });
  assert.deepEqual(await first.answer, yes([null, null]));
  // The same commands, together or one at a time, raise no card.
  for (const fills of [[PASSWORD, CODE], [CODE], [PASSWORD]]) {
    const again = await ask({ sessionId: "chat", site: SITE, fills });
    assert.deepEqual([again.raised, await again.answer], [false, yes(fills.map(() => null))]);
  }
  // Anything else about it does: another site, another field, another argument, another chat, or one new command.
  const others = [
    { sessionId: "chat", site: "https://other.example", fills: [PASSWORD] },
    { sessionId: "chat", site: SITE, fills: [{ ...PASSWORD, field: "text" }] },
    { sessionId: "chat", site: SITE, fills: [{ ...PASSWORD, command: [...PASSWORD.command, "--reveal"] }] },
    { sessionId: "chat", site: SITE, fills: [{ ...PASSWORD, command: ["op", "read", "op://Private/Other/password"] }] },
    { sessionId: "another chat", site: SITE, fills: [PASSWORD] },
    { sessionId: "chat", site: SITE, fills: [PASSWORD, { field: "text", command: ["pass", "show", "example"] }] },
    { sessionId: "chat", site: SITE, fills: [PASSWORD, ASKED] },
  ];
  for (const input of others) {
    const other = await ask(input);
    assert.equal(other.raised, true, JSON.stringify(input));
    assert.deepEqual(other.request.credential, { site: input.site, fills: input.fills });
    await control.answerRequest({ sessionId: input.sessionId, answer: "dismiss", id: other.request.id });
    assert.deepEqual(await other.answer, NO);
  }
});

test("a standing answer for commands and one for typed credentials never cover each other", async () => {
  const { control, ask } = broker();
  const typed = await ask({ sessionId: "chat", site: SITE });
  await control.answerRequest({ sessionId: "chat", answer: "always", id: typed.request.id });
  assert.equal(await typed.answer, true);
  const command = await ask({ sessionId: "chat", site: SITE, fills: [PASSWORD] });
  assert.equal(command.raised, true);
  await control.answerRequest({ sessionId: "chat", answer: "always", id: command.request.id });
  assert.deepEqual(await command.answer, yes());
  const secret = await ask({ sessionId: "chat", site: SITE, secret: { label: "Billing sign-in", kind: "password", field: "password" } });
  assert.equal(secret.raised, true);
  await control.answerRequest({ sessionId: "chat", answer: "dismiss", id: secret.request.id });
  assert.equal(await secret.answer, false);
});

test("fills that cannot be shown whole, or a site that is not an exact https origin, are refused without asking", async () => {
  const { control, shown } = broker();
  const refused = [
    null, "op read", [], {}, [null], [PASSWORD.command],
    [{ command: PASSWORD.command }],
    [{ field: "", command: PASSWORD.command }],
    [{ field: "x".repeat(81), command: PASSWORD.command }],
    [{ field: "password", command: "op read op://Private/Example/password" }],
    [{ field: "password", command: [] }],
    [{ field: "password", command: ["./op", "read"] }],
    [{ field: "password", command: ["op", "read\nmore"] }],
    [{ field: "password", command: ["op", 7] }],
    Array.from({ length: 7 }, () => PASSWORD),
    [{ field: "password" }],
    [{ field: "password", ask: "" }],
    [{ field: "password", ask: " Example password" }],
    [{ field: "password", ask: "x".repeat(81) }],
    [{ field: "password", ask: "Example‮password" }],
    [{ field: "password", ask: "Example\npassword" }],
    [{ field: "password", ask: 7 }],
    [{ ...PASSWORD, ask: "Example password" }],
    [{ ...PASSWORD, kept: true }],
    [{ ...ASKED, kept: false }],
    [{ ...ASKED, kept: "yes" }],
    // A key row comes after the fields, names a safe variable, and is read by exactly one listed program.
    [KEY],
    [KEY, LOCKED],
    [LOCKED],
    [LOCKED, KEY, KEY],
    [LOCKED, { ...KEY, program: "bw" }],
    [LOCKED, { ...KEY, unlock: "OTHER_KEY" }],
    [LOCKED, { ...KEY, unlock: "PATH" }],
    [{ ...LOCKED, needs: "PATH" }, { ...KEY, unlock: "PATH" }],
    [LOCKED, { ...KEY, ask: "" }],
    [LOCKED, { ...KEY, kept: false }],
    [LOCKED, { ...KEY, field: "password" }],
    [LOCKED, { ...KEY, command: LOCKED.command }],
    [{ ...ASKED, needs: "BW_SESSION" }, KEY],
    [PASSWORD, KEY],
  ];
  for (const fills of refused) assert.deepEqual(await control.approveValues({ sessionId: "chat", site: SITE, fills }), NO, JSON.stringify(fills));
  for (const site of ["http://app.example", `${SITE}/sign-in`, "app.example", "http://127.0.0.1:3000", undefined]) {
    assert.deepEqual(await control.approveValues({ sessionId: "chat", site, fills: [PASSWORD] }), NO, String(site));
  }
  for (const use of [{ kind: "run", command: ["./deploy"] }, { kind: "run", command: ["gh"], cwd: "/" }, { kind: "shell", command: ["gh"] },
    { kind: "request", method: "GET", url: "http://api.example/x", origin: "http://api.example" },
    { kind: "request", method: "GET", url: "https://api.example/x?token=1", origin: "https://api.example" },
    { kind: "request", method: "GET", url: "https://api.example/x", origin: "https://other.example" },
    { kind: "request", method: "TRACE", url: "https://api.example/x", origin: "https://api.example" }]) {
    assert.deepEqual(await control.approveValues({ sessionId: "chat", use, fills: [PASSWORD] }), NO, JSON.stringify(use));
  }
  assert.equal(shown.length, 0);
});

test("a value used outside a page shows the program or the request in place of a site, and Always covers exactly that use", async () => {
  const { control, ask } = broker();
  const run = { kind: "run", command: ["gh", "api", "user"] };
  const token = { field: "$GH_TOKEN", command: PASSWORD.command };
  const first = await ask({ sessionId: "chat", use: run, fills: [token] });
  assert.deepEqual(first.request.credential, { use: run, fills: [token] });
  await control.answerRequest({ sessionId: "chat", answer: "always", id: first.request.id });
  assert.deepEqual(await first.answer, yes([null]));
  assert.deepEqual(await control.approveValues({ sessionId: "chat", use: run, fills: [token] }), yes([null]));
  const other = await ask({ sessionId: "chat", use: { kind: "run", command: ["gh", "api", "orgs"] }, fills: [token] });
  assert.equal(other.raised, true, "another command asks again");
  await control.answerRequest({ sessionId: "chat", answer: "dismiss", id: other.request.id });
  const request = { kind: "request", method: "POST", url: "https://api.example/v1/login", origin: "https://api.example" };
  const sent = await ask({ sessionId: "chat", use: request, fills: [{ field: "header Authorization", ask: "Example token" }] });
  assert.deepEqual(sent.request.credential.use, request);
  assert.equal(sent.request.standing, false);
  await control.answerRequest({ sessionId: "chat", answer: "dismiss", id: sent.request.id });

  const sealing = { ...request, seal: [{ name: "API_TOKEN", from: "access_token", for: "https://api.example" }] };
  const sealed = await ask({ sessionId: "chat", use: sealing, fills: [{ field: "request body", command: PASSWORD.command }] });
  assert.deepEqual(sealed.request.credential.use, sealing);
  assert.equal(sealed.request.standing, false, "a request that keeps a value never offers Always");
  await control.answerRequest({ sessionId: "chat", answer: "dismiss", id: sealed.request.id });
  for (const seal of [[{ name: "lower", from: "a", for: "https://api.example" }], [{ name: "A", from: "a", for: "http://api.example" }], [{ name: "A", from: "a" }]]) {
    assert.deepEqual(await control.approveValues({ sessionId: "chat", use: { ...request, seal }, fills: [{ field: "request body", command: PASSWORD.command }] }), NO, JSON.stringify(seal));
  }
});

test("the typed-credential question takes no fills: a card of commands is only ever raised as one", async () => {
  const { control, ask } = broker();
  const typed = await ask({ sessionId: "chat", site: SITE });
  assert.deepEqual(typed.request.credential, { site: SITE });
  await assert.rejects(control.answerRequest({ sessionId: "chat", answer: "allow", id: typed.request.id, values: ["hunter2-pasted"] }), /takes no pasted value/);
  await control.answerRequest({ sessionId: "chat", answer: "dismiss", id: typed.request.id });
  assert.equal(await typed.answer, false);
});

test("the card carries only the field and source of what it was given", async () => {
  const { control, ask } = broker();
  const { answer, request } = await ask({ sessionId: "chat", site: SITE, fills: [{ ...PASSWORD, value: "never shown", env: { MADE_UP: "x" } }, { ...ASKED, value: "never shown" }] });
  assert.deepEqual(request.credential, { site: SITE, fills: [PASSWORD, ASKED] });
  await control.answerRequest({ sessionId: "chat", answer: "dismiss", id: request.id });
  assert.deepEqual(await answer, NO);
});

test("a value the person is asked for comes back with their yes, from the card alone, and is never standing", async () => {
  const { control, ask, shown } = broker();
  const first = await ask({ sessionId: "chat", site: SITE, fills: [PASSWORD, ASKED] });
  assert.equal(first.request.standing, false);
  assert.deepEqual(first.request.credential, { site: SITE, fills: [PASSWORD, ASKED] });
  // A yes without the value, a value that is too short, and an "always" are each refused: the card stays up.
  await assert.rejects(control.answerRequest({ sessionId: "chat", answer: "allow", id: first.request.id }), /Paste the value first/);
  await assert.rejects(control.answerRequest({ sessionId: "chat", answer: "allow", id: first.request.id, values: [null, "abc"] }), /4 to 4096/);
  await assert.rejects(control.answerRequest({ sessionId: "chat", answer: "allow", id: first.request.id, values: [null, { toString: () => "hunter2-pasted" }] }), /4 to 4096/);
  await assert.rejects(control.answerRequest({ sessionId: "chat", answer: "allow", id: first.request.id, values: ["hunter2-pasted"] }), /request changed/);
  await assert.rejects(control.answerRequest({ sessionId: "chat", answer: "allow", id: first.request.id, values: [null, "hunter2-pasted"], keep: [true] }), /request changed/);
  await assert.rejects(control.answerRequest({ sessionId: "chat", answer: "always", id: first.request.id, values: [null, "hunter2-pasted"] }), /used once/);
  await control.answerRequest({ sessionId: "chat", answer: "allow", id: first.request.id, values: [null, "hunter2-pasted"], keep: [true, true] });
  // Keeping is for a value asked for by name: never for the command's field beside it.
  assert.deepEqual(await first.answer, yes([null, "hunter2-pasted"], [false, true]));
  // Nothing about the answer is in what was shown, and the same request asks again.
  assert.equal(JSON.stringify(shown).includes("hunter2-pasted"), false);
  const second = await ask({ sessionId: "chat", site: SITE, fills: [ASKED] });
  assert.equal(second.raised, true);
  await control.answerRequest({ sessionId: "chat", answer: "dismiss", id: second.request.id, });
  assert.deepEqual(await second.answer, NO);
});

test("a value pasted in place of a command is used once: it cannot be made standing", async () => {
  const { control, ask } = broker();
  const first = await ask({ sessionId: "chat", site: SITE, fills: [PASSWORD] });
  assert.equal(first.request.standing, undefined);
  await assert.rejects(control.answerRequest({ sessionId: "chat", answer: "always", id: first.request.id, values: ["hunter2-pasted"] }), { message: "A pasted value is used once. Choose Fill." });
  await control.answerRequest({ sessionId: "chat", answer: "allow", id: first.request.id, values: ["hunter2-pasted"], keep: [true] });
  assert.deepEqual(await first.answer, yes(["hunter2-pasted"], [false]));
  const second = await ask({ sessionId: "chat", site: SITE, fills: [PASSWORD] });
  assert.equal(second.raised, true);
  await control.answerRequest({ sessionId: "chat", answer: "dismiss", id: second.request.id });
});

test("a value kept for this chat still asks, and needs nothing pasted", async () => {
  const { control, ask } = broker();
  const kept = { ...ASKED, kept: true };
  const first = await ask({ sessionId: "chat", site: SITE, fills: [kept] });
  assert.equal(first.request.standing, false);
  assert.deepEqual(first.request.credential, { site: SITE, fills: [kept] });
  await assert.rejects(control.answerRequest({ sessionId: "chat", answer: "always", id: first.request.id }), /used once/);
  await control.answerRequest({ sessionId: "chat", answer: "allow", id: first.request.id });
  assert.deepEqual(await first.answer, yes());
  const second = await ask({ sessionId: "chat", site: SITE, fills: [kept] });
  assert.equal(second.raised, true);
  await control.answerRequest({ sessionId: "chat", answer: "allow", id: second.request.id, values: ["another-pasted"], keep: [false] });
  assert.deepEqual(await second.answer, yes(["another-pasted"]));
});

test("a declined or timed-out card returns nothing that was pasted", async () => {
  const { control, ask } = broker();
  const first = await ask({ sessionId: "chat", site: SITE, fills: [ASKED] });
  await assert.rejects(control.answerRequest({ sessionId: "chat", answer: "dismiss", id: first.request.id, values: ["hunter2-pasted"] }), /takes no pasted value/);
  await control.answerRequest({ sessionId: "chat", answer: "dismiss", id: first.request.id });
  assert.deepEqual(await first.answer, NO);
});

test("a key a command needs is its own row, comes back with the yes from the card alone, and is never standing", async () => {
  const { control, ask, shown } = broker();
  const first = await ask({ sessionId: "chat", site: SITE, fills: [{ ...LOCKED, value: "never shown" }, CODE, { ...KEY, value: "never shown", env: { MADE_UP: "x" } }] });
  assert.equal(first.request.standing, false);
  assert.deepEqual(first.request.credential, { site: SITE, fills: [LOCKED, CODE, KEY] });
  await assert.rejects(control.answerRequest({ sessionId: "chat", answer: "allow", id: first.request.id }), /Paste the value first/);
  await assert.rejects(control.answerRequest({ sessionId: "chat", answer: "allow", id: first.request.id, values: [null, null, "abc"] }), /4 to 4096/);
  await assert.rejects(control.answerRequest({ sessionId: "chat", answer: "allow", id: first.request.id, values: [null, null, "two\nlines"] }), /one line/);
  await assert.rejects(control.answerRequest({ sessionId: "chat", answer: "always", id: first.request.id, values: [null, null, "made-up-session-key"] }), /used once/);
  await control.answerRequest({ sessionId: "chat", answer: "allow", id: first.request.id, values: [null, null, "made-up-session-key"], keep: [true, true, true] });
  // Keeping is for the key: never for a command's field.
  assert.deepEqual(await first.answer, yes([null, null, "made-up-session-key"], [false, false, true]));
  assert.equal(JSON.stringify(shown).includes("made-up-session-key"), false);
});

test("a kept key still asks, and no key is needed once the field of every command that reads it was pasted instead", async () => {
  const { control, ask } = broker();
  const kept = { ...KEY, kept: true };
  const first = await ask({ sessionId: "chat", site: SITE, fills: [LOCKED, kept] });
  assert.equal(first.request.standing, false);
  assert.deepEqual(first.request.credential, { site: SITE, fills: [LOCKED, kept] });
  await assert.rejects(control.answerRequest({ sessionId: "chat", answer: "always", id: first.request.id }), /used once/);
  await control.answerRequest({ sessionId: "chat", answer: "allow", id: first.request.id });
  assert.deepEqual(await first.answer, yes([null, null]));
  const again = await ask({ sessionId: "chat", site: SITE, fills: [LOCKED, kept] });
  assert.equal(again.raised, true);
  await control.answerRequest({ sessionId: "chat", answer: "dismiss", id: again.request.id });

  const second = await ask({ sessionId: "chat", site: SITE, fills: [LOCKED, CODE, KEY] });
  // The other command reads no key, so pasting over the one that does leaves nothing to unlock.
  await control.answerRequest({ sessionId: "chat", answer: "allow", id: second.request.id, values: ["hunter2-pasted", null, null] });
  assert.deepEqual(await second.answer, yes(["hunter2-pasted", null, null]));
  const third = await ask({ sessionId: "chat", site: SITE, fills: [LOCKED, { ...LOCKED, field: "text" }, KEY] });
  await assert.rejects(control.answerRequest({ sessionId: "chat", answer: "allow", id: third.request.id, values: ["hunter2-pasted", null, null] }), /Paste the value first/);
  await control.answerRequest({ sessionId: "chat", answer: "dismiss", id: third.request.id });
});

test("limits narrow the card: asked every time offers no Always and ignores one given before, and nothing pasted or kept is taken", async () => {
  const { control, ask } = broker();
  const first = await ask({ sessionId: "chat", site: SITE, fills: [PASSWORD] });
  await control.answerRequest({ sessionId: "chat", answer: "always", id: first.request.id });
  await first.answer;
  const every = await ask({ sessionId: "chat", site: SITE, fills: [PASSWORD], limits: { everyTime: true } });
  assert.deepEqual([every.raised, every.request.standing], [true, false]);
  await assert.rejects(control.answerRequest({ sessionId: "chat", answer: "always", id: every.request.id }), { message: "Your organization asks you to approve each fill. Choose Fill." });
  await control.answerRequest({ sessionId: "chat", answer: "allow", id: every.request.id });
  assert.deepEqual(await every.answer, yes());

  const noPaste = await ask({ sessionId: "other", site: SITE, fills: [PASSWORD], limits: { paste: false, keep: false } });
  assert.deepEqual(noPaste.request.credential, { site: SITE, fills: [PASSWORD], paste: false, keep: false });
  await assert.rejects(control.answerRequest({ sessionId: "other", answer: "allow", id: noPaste.request.id, values: ["hunter2-pasted"] }), /turned off/);
  await control.answerRequest({ sessionId: "other", answer: "allow", id: noPaste.request.id });
  assert.deepEqual(await noPaste.answer, yes());

  const noKeep = await ask({ sessionId: "other", site: SITE, fills: [ASKED], limits: { keep: false } });
  assert.deepEqual(noKeep.request.credential, { site: SITE, fills: [ASKED], keep: false });
  await control.answerRequest({ sessionId: "other", answer: "allow", id: noKeep.request.id, values: ["hunter2-pasted"], keep: [true] });
  assert.deepEqual(await noKeep.answer, yes(["hunter2-pasted"], [false]));
});

test("every Always is listed with its chat, site, field and command, and ends one at a time or all at once", async () => {
  const { control, ask } = broker();
  for (const [sessionId, fills] of [["chat", [PASSWORD, CODE]], ["other", [PASSWORD]]]) {
    const card = await ask({ sessionId, site: SITE, fills });
    await control.answerRequest({ sessionId, answer: "always", id: card.request.id });
    await card.answer;
  }
  const listed = control.listValueGrants();
  assert.deepEqual(listed.map(({ sessionId, site, field, command }) => [sessionId, site, field, command]),
    [["chat", SITE, "password", PASSWORD.command], ["chat", SITE, "number", CODE.command], ["other", SITE, "password", PASSWORD.command]]);
  assert.equal(new Set(listed.map((grant) => grant.id)).size, 3);
  assert.equal(control.removeValueGrant("not json"), false);
  assert.equal(control.removeValueGrant(JSON.stringify(["chat", "nothing"])), false);
  assert.equal(control.removeValueGrant(listed[0].id), true);
  assert.equal(control.removeValueGrant(listed[0].id), false);
  // The command whose Always ended asks again; the one beside it and the other chat's do not.
  assert.equal((await ask({ sessionId: "chat", site: SITE, fills: [CODE] })).raised, false);
  assert.equal((await ask({ sessionId: "other", site: SITE, fills: [PASSWORD] })).raised, false);
  const again = await ask({ sessionId: "chat", site: SITE, fills: [PASSWORD] });
  assert.equal(again.raised, true);
  await control.answerRequest({ sessionId: "chat", answer: "dismiss", id: again.request.id });
  assert.equal(control.removeValueGrant(), true);
  assert.deepEqual(control.listValueGrants(), []);
  const all = await ask({ sessionId: "other", site: SITE, fills: [PASSWORD] });
  assert.equal(all.raised, true);
  await control.answerRequest({ sessionId: "other", answer: "dismiss", id: all.request.id });
});
