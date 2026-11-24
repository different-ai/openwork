import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";
import { createBrowserSecrets } from "../../../packages/computer-use/browser-secrets.mjs";
import { createPrivateValueUse } from "../../../packages/computer-use/private-value-use.mjs";
import { createPrivateTextFilter } from "../../desktop/electron/private-text-filter.mjs";
import { createUiControlServer } from "../../desktop/electron/ui-control-server.mjs";
import { UNCHECKED } from "../src/opencode-plugins/private-values-filter.js";
import * as legacy from "../src/opencode-plugins/openwork-private-values.js";
import privateValuesV2, { type PrivateValuesContext } from "../src/opencode-plugins/openwork-private-values-v2.js";
import { createV2PrivateValuesBridge } from "../src/opencode-v2-private-values-bridge.js";

const PASSWORD = "made-up-vault-password-91";

test("the older engine's plugin, through the app's own bridge: off, on, then held back once the app is gone", async () => {
  assert.deepEqual(Object.keys(legacy), ["OpenWorkPrivateValues"], "the engine loads every export of a plugin file as a plugin");
  const directory = await mkdtemp(join(tmpdir(), "openwork-private-bridge-"));
  const previous = process.env.OPENWORK_UI_CONTROL_DISCOVERY;
  const secrets = createBrowserSecrets();
  let enabled = false;
  const bridge = createUiControlServer({
    app: { getPath: () => directory }, appName: "Bridge test", appIdentifier: "test.openwork.bridge",
    getWindow: async () => { throw new Error("The app window takes no part in this."); },
    redactPrivate: createPrivateTextFilter({ secrets, enabled: async () => enabled }),
  });
  await bridge.start();
  let stopped = false;
  onTestFinished(async () => {
    if (!stopped) await bridge.stop();
    await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENWORK_UI_CONTROL_DISCOVERY;
    else process.env.OPENWORK_UI_CONTROL_DISCOVERY = previous;
  });

  const hooks = await legacy.OpenWorkPrivateValues();
  assert.deepEqual(Object.keys(hooks).sort(), ["experimental.chat.messages.transform", "experimental.chat.system.transform", "tool.execute.after", "tool.execute.before"]);
  const conversation = () => ({
    messages: [{
      info: { id: "msg_1", role: "assistant" },
      parts: [{ type: "tool", tool: "bash", callID: "call_1", state: { status: "completed", input: { command: `echo ${PASSWORD}` }, output: `${PASSWORD}\n` } }],
    }] as unknown[],
  });
  const send = async () => {
    const output = conversation();
    const system = { system: [`Never repeat ${PASSWORD}.`] };
    await hooks["experimental.chat.messages.transform"]({}, output);
    await hooks["experimental.chat.system.transform"]({}, system);
    return JSON.stringify([output, system]);
  };

  assert.ok((await send()).includes(PASSWORD), "nothing is held yet");
  secrets.remember(PASSWORD);
  assert.ok((await send()).includes(PASSWORD), "the feature is off");

  enabled = true;
  const sent = await send();
  assert.ok(!sent.includes(PASSWORD));
  assert.ok(sent.includes("echo [secret]") && sent.includes("Never repeat [secret]."));

  const result = { title: "bash", output: `${PASSWORD}\n`, metadata: { stdout: PASSWORD } };
  await hooks["tool.execute.after"]({ tool: "bash" }, result);
  assert.deepEqual(result, { title: "bash", output: "[secret]\n", metadata: { stdout: "[secret]" } });

  await bridge.stop();
  stopped = true;
  await assert.rejects(send(), { message: UNCHECKED });
  const late = { title: "bash", output: PASSWORD, metadata: {} };
  await hooks["tool.execute.after"]({ tool: "bash" }, late);
  assert.equal(late.output, PASSWORD, "a finished tool is not failed; the next call to the model is what is held back");
});

test("the newer engine's plugin reaches the app only through the relay its server hands it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwork-private-relay-"));
  const previous = process.env.OPENWORK_UI_CONTROL_DISCOVERY;
  const secrets = createBrowserSecrets();
  const bridge = createUiControlServer({
    app: { getPath: () => directory }, appName: "Relay test", appIdentifier: "test.openwork.relay",
    getWindow: async () => { throw new Error("The app window takes no part in this."); },
    redactPrivate: createPrivateTextFilter({ secrets, enabled: async () => true }),
  });
  await bridge.start();
  const relay = await createV2PrivateValuesBridge();
  onTestFinished(async () => {
    await relay.close();
    await bridge.stop();
    await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENWORK_UI_CONTROL_DISCOVERY;
    else process.env.OPENWORK_UI_CONTROL_DISCOVERY = previous;
  });

  const post = (token: string, path: string, body: string) => fetch(new URL(path, relay.url), {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body,
  });
  assert.equal((await post("not-the-token", "/redact", "{}")).status, 401);
  assert.equal((await post(relay.token, "/elsewhere", "{}")).status, 404);
  assert.equal((await post(relay.token, "/redact", "not json")).status, 400);

  type Request = { system: unknown; messages: unknown };
  const plugin = async (options: PrivateValuesContext["options"]) => {
    const requests: ((event: Request) => Promise<void>)[] = [];
    await privateValuesV2.setup({
      options,
      session: { hook: async (_name, callback) => { requests.push(callback); return { dispose: async () => {} }; } },
      tool: { hook: async () => ({ dispose: async () => {} }) },
    });
    return async () => {
      const event = { system: [{ type: "text", text: `Never repeat ${PASSWORD}.` }], messages: [{ role: "tool", content: [{ type: "tool-result", result: { type: "text", value: `${PASSWORD}\n` } }] }] };
      for (const request of requests) await request(event);
      return JSON.stringify(event);
    };
  };

  const send = await plugin({ url: relay.url, token: relay.token });
  assert.ok((await send()).includes(PASSWORD), "nothing is held yet");
  secrets.remember(PASSWORD);
  const sent = await send();
  assert.ok(!sent.includes(PASSWORD));
  assert.ok(sent.includes("Never repeat [secret].") && sent.includes("[secret]\\n"));

  const refused = await plugin({ url: relay.url, token: "not-the-token" });
  assert.ok((await refused()).includes(PASSWORD), "a plugin that never reached the app has nothing to hold back");
  await relay.close();
  await assert.rejects(send(), { message: UNCHECKED });
});

test("the newer engine's bridge passes the terminal question to the app and nothing else", async () => {
  const asked: unknown[] = [];
  const relay = await createV2PrivateValuesBridge({ redact: async () => ({ held: false }), terminal: async (body) => { asked.push(body); return { ok: true, blocked: true, source: "Everyone" }; } });
  onTestFinished(() => relay.close());
  const post = (token: string, path: string) => fetch(new URL(path, relay.url), {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ check: true }),
  });
  assert.equal((await post("not-the-token", "/terminal")).status, 401);
  assert.equal((await post(relay.token, "/other")).status, 404);
  const answered = await post(relay.token, "/terminal");
  assert.equal(answered.status, 200);
  assert.deepEqual(await answered.json(), { ok: true, blocked: true, source: "Everyone" });
  assert.deepEqual(asked, [{ check: true }]);
});

test("both engines offer use_private_values only while the app says the feature is on, and it runs a program with no browser in the app", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwork-private-use-"));
  const previous = process.env.OPENWORK_UI_CONTROL_DISCOVERY;
  const secrets = createBrowserSecrets();
  const read = ["vault-cli", "read", "deploy/token"];
  const approved: unknown[] = [];
  let enabled = false;
  const use = createPrivateValueUse({
    secrets,
    enabled: () => enabled,
    approveValues: async (_sessionId, request) => { approved.push(request); return { approved: true, values: request.fills.map(() => null), keep: request.fills.map(() => false) }; },
    runValueCommand: async (command) => command.join(" ") === read.join(" ") ? { ok: true, value: PASSWORD } : { ok: false, code: "command_not_found" },
  });
  const desktop = createUiControlServer({
    app: { getPath: () => directory }, appName: "Use test", appIdentifier: "test.openwork.use",
    getWindow: async () => { throw new Error("The app window takes no part in this."); },
    privateValuesOn: async () => enabled,
    privateValueUse: (request: unknown, options: { signal?: AbortSignal }) => use.request(request, options),
  });
  await desktop.start();
  const relay = await createV2PrivateValuesBridge();
  onTestFinished(async () => {
    await relay.close();
    await desktop.stop();
    await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENWORK_UI_CONTROL_DISCOVERY;
    else process.env.OPENWORK_UI_CONTROL_DISCOVERY = previous;
  });

  type Added = { name: string; execute(input: unknown, call: { signal: AbortSignal; sessionID: string }): Promise<{ content: { type: "text"; text: string }[] }> };
  const newer = async () => {
    const added: Added[] = [];
    await privateValuesV2.setup({
      options: { url: relay.url, token: relay.token },
      location: { directory },
      session: { hook: async () => ({ dispose: async () => {} }) },
      tool: { hook: async () => ({ dispose: async () => {} }), transform: async (callback) => { callback({ add: tool => { added.push(tool); } }); return { dispose: async () => {} }; } },
    });
    return added;
  };

  assert.ok(!("tool" in await legacy.OpenWorkPrivateValues()), "off: the older engine has no such tool");
  assert.deepEqual(await newer(), [], "off: the newer engine has no such tool");

  enabled = true;
  const input = { values: [{ name: "DEPLOY_TOKEN", command: read }], run: { command: [process.execPath, "-e", "process.stdout.write('token ' + process.env.DEPLOY_TOKEN)"] } };
  const older = await legacy.OpenWorkPrivateValues();
  assert.ok("tool" in older);
  const first = JSON.parse(await older.tool.use_private_values.execute(input, { sessionID: "ses_older", directory }));
  assert.deepEqual([first.ok, first.output], [true, "token [secret]"], JSON.stringify(first));

  const [tool] = await newer();
  assert.equal(tool?.name, "use_private_values");
  const second = await tool.execute(input, { sessionID: "ses_newer", signal: new AbortController().signal });
  const answer = JSON.parse(second.content[0]?.text ?? "{}");
  assert.deepEqual([answer.ok, answer.output], [true, "token [secret]"], second.content[0]?.text);
  assert.ok(!JSON.stringify([first, second]).includes(PASSWORD));
  assert.equal(approved.length, 2, "each use asked the person");

  await desktop.stop();
  const gone = JSON.parse(await older.tool.use_private_values.execute(input, { sessionID: "ses_older", directory }));
  assert.equal(gone.ok, false);
  assert.ok(["values_unavailable", "values_interrupted"].includes(gone.code), gone.code);
});
