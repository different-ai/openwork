import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBrowserSecrets } from "../../../packages/computer-use/browser-secrets.mjs";
import { createPrivateValueUse } from "../../../packages/computer-use/private-value-use.mjs";
import { createPrivateTextFilter } from "../electron/private-text-filter.mjs";
import { createUiControlServer } from "../electron/ui-control-server.mjs";

const VALUE = "made-up-vault-password-91";

async function bridge(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "openwork-private-redact-"));
  const previous = process.env.OPENWORK_UI_CONTROL_DISCOVERY;
  const server = createUiControlServer({
    app: { getPath: () => directory }, appName: "Redact test", appIdentifier: "test.openwork.redact",
    getWindow: async () => { throw new Error("The app window takes no part in this."); },
    ...options,
  });
  await server.start();
  t.after(async () => {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENWORK_UI_CONTROL_DISCOVERY;
    else process.env.OPENWORK_UI_CONTROL_DISCOVERY = previous;
  });
  const { baseUrl, token } = JSON.parse(await readFile(path.join(directory, "openwork-ui-control.json"), "utf8"));
  return (body, headers = { authorization: `Bearer ${token}` }, route = "redact") =>
    fetch(`${baseUrl}/private/${route}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

function redactWith(secrets, enabled = async () => true) {
  return createPrivateTextFilter({ secrets, enabled });
}

test("only a caller with the bridge's token may ask", async (t) => {
  const secrets = createBrowserSecrets();
  secrets.remember(VALUE);
  const ask = await bridge(t, { redactPrivate: redactWith(secrets) });
  const denied = await ask({ texts: [VALUE] }, {});
  assert.equal(denied.status, 401);
  assert.ok(!(await denied.text()).includes(VALUE));
});

test("while nothing is held the answer is only that, whatever was sent", async (t) => {
  const secrets = createBrowserSecrets();
  const ask = await bridge(t, { redactPrivate: redactWith(secrets) });
  assert.deepEqual(await (await ask({ probe: true })).json(), { ok: true, held: false });
  assert.deepEqual(await (await ask({ texts: ["nothing private here"] })).json(), { ok: true, held: false });
});

test("a held value comes back replaced in every text, in the order sent, in any encoding the store knows", async (t) => {
  const secrets = createBrowserSecrets();
  secrets.remember(VALUE);
  const ask = await bridge(t, { redactPrivate: redactWith(secrets) });
  assert.deepEqual(await (await ask({ probe: true })).json(), { ok: true, held: true });
  const encoded = Buffer.from(VALUE, "utf8").toString("base64");
  const reply = await (await ask({ texts: ["plain text", `the password is ${VALUE}`, `{"password":"${VALUE}"}`, encoded] })).json();
  assert.equal(reply.ok, true);
  assert.equal(reply.held, true);
  assert.equal(reply.texts.length, 4);
  assert.equal(reply.texts[0], "plain text");
  assert.equal(reply.texts[1], "the password is [secret]");
  assert.ok(!JSON.stringify(reply).includes(VALUE));
  assert.ok(!JSON.stringify(reply).includes(encoded));
});

test("a request that is not a list of texts gets no texts back, so its sender cannot take it as checked", async (t) => {
  const secrets = createBrowserSecrets();
  secrets.remember(VALUE);
  const ask = await bridge(t, { redactPrivate: redactWith(secrets) });
  for (const body of [{ texts: [VALUE, 7] }, { texts: VALUE }, { text: VALUE }, {}]) {
    assert.deepEqual(await (await ask(body)).json(), { ok: true, held: true });
  }
});

test("a feature that is off leaves text alone even while a secret is held", async (t) => {
  const secrets = createBrowserSecrets();
  secrets.remember(VALUE);
  const ask = await bridge(t, { redactPrivate: redactWith(secrets, async () => false) });
  assert.deepEqual(await (await ask({ texts: [VALUE] })).json(), { ok: true, held: false });
});

test("the feature is not asked about while nothing is held, and once on it stays on when the answer changes", async (t) => {
  const secrets = createBrowserSecrets();
  let enabled = false;
  let asked = 0;
  const ask = await bridge(t, { redactPrivate: redactWith(secrets, async () => { asked += 1; return enabled; }) });
  assert.deepEqual(await (await ask({ texts: [VALUE] })).json(), { ok: true, held: false });
  assert.equal(asked, 0);
  secrets.remember(VALUE);
  assert.deepEqual(await (await ask({ texts: [VALUE] })).json(), { ok: true, held: false });
  enabled = true;
  assert.deepEqual(await (await ask({ texts: [VALUE] })).json(), { ok: true, held: true, texts: ["[secret]"] });
  enabled = false;
  assert.deepEqual(await (await ask({ texts: [VALUE] })).json(), { ok: true, held: true, texts: ["[secret]"] });
  assert.equal(asked, 2);
});

test("an app without the feature answers that nothing is held", async (t) => {
  const ask = await bridge(t);
  assert.deepEqual(await (await ask({ texts: [VALUE] })).json(), { ok: true, held: false });
});

test("a failure says nothing of what was sent", async (t) => {
  const ask = await bridge(t, { redactPrivate: async () => { throw new Error(`could not check ${VALUE}`); } });
  const failed = await ask({ texts: [VALUE] });
  assert.equal(failed.status, 500);
  assert.ok(!(await failed.text()).includes(VALUE));
});

test("a long conversation fits in one request", async (t) => {
  const secrets = createBrowserSecrets();
  secrets.remember(VALUE);
  const ask = await bridge(t, { redactPrivate: redactWith(secrets) });
  const long = `${"words and more words ".repeat(400_000)}${VALUE}`;
  const reply = await (await ask({ texts: [long] })).json();
  assert.equal(reply.texts[0].endsWith("[secret]"), true);
  assert.equal(reply.texts[0].length, long.length - VALUE.length + "[secret]".length);
});

test("the feature's state is reported as on only when the app both has it and says so", async (t) => {
  let on = false;
  const ask = await bridge(t, { privateValuesOn: async () => on, privateValueUse: async () => ({ ok: true }) });
  assert.deepEqual(await (await ask({ check: true }, undefined, "state")).json(), { ok: true, enabled: false });
  on = true;
  assert.deepEqual(await (await ask({ check: true }, undefined, "state")).json(), { ok: true, enabled: true });
  assert.equal((await ask({ check: true }, {}, "state")).status, 401);

  const without = await bridge(t, { privateValuesOn: async () => true });
  assert.deepEqual(await (await without({ check: true }, undefined, "state")).json(), { ok: true, enabled: false });
});

test("a value is given to a program in an app that has no browser, and what comes back does not hold it", async (t) => {
  const secrets = createBrowserSecrets();
  const read = ["vault-cli", "read", "deploy/token"];
  const asked = [];
  const use = createPrivateValueUse({
    secrets,
    enabled: () => true,
    approveValues: async (sessionId, request) => { asked.push(sessionId); return { approved: true, values: request.fills.map(() => null), keep: request.fills.map(() => false) }; },
    runValueCommand: async (command) => command.join(" ") === read.join(" ") ? { ok: true, value: VALUE } : { ok: false, code: "command_not_found" },
  });
  const ask = await bridge(t, { privateValueUse: (request, options) => use.request(request, options) });
  const args = { values: [{ name: "DEPLOY_TOKEN", command: read }], run: { command: [process.execPath, "-e", "process.stdout.write('token ' + process.env.DEPLOY_TOKEN)"] } };

  assert.equal((await ask({ sessionId: "ses_1", args }, {}, "use")).status, 401);
  assert.deepEqual(asked, []);

  const response = await ask({ sessionId: "ses_1", args }, undefined, "use");
  const text = await response.text();
  const reply = JSON.parse(text);
  assert.deepEqual([response.status, reply.ok, reply.output], [200, true, "token [secret]"], text);
  assert.ok(!text.includes(VALUE));
  assert.deepEqual(asked, ["ses_1"]);
});

test("an app without the feature refuses a use without running anything", async (t) => {
  const ask = await bridge(t);
  const response = await ask({ sessionId: "ses_1", args: { values: [{ name: "A", ask: "A value" }], run: { command: ["true"] } } }, undefined, "use");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, code: "values_unavailable" });
});
