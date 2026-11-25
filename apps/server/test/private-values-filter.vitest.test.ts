import assert from "node:assert/strict";
import { test } from "vitest";
import { createBrowserSecrets } from "../../../packages/computer-use/browser-secrets.mjs";
import { OUTGOING, STORED, UNCHECKED, createPrivateValueScrubber, plainCopy, type RedactRequest } from "../src/opencode-plugins/private-values-filter.js";
import { registerPrivateValues, type PrivateValuesContext } from "../src/opencode-plugins/openwork-private-values-v2.js";

const PASSWORD = "made-up-vault-password-91";
const CODE = "735102";
const ENCODED = Buffer.from(PASSWORD, "utf8").toString("base64");

function held(...values: string[]) {
  const secrets = createBrowserSecrets();
  for (const value of values) assert.equal(secrets.remember(value), true);
  const sent: Array<string[] | null> = [];
  const request: RedactRequest = async texts => {
    sent.push(texts);
    if (!secrets.holding()) return { held: false };
    return texts ? { held: true, texts: texts.map(text => secrets.redactText(text)) } : { held: true };
  };
  return { secrets, sent, request, scrub: createPrivateValueScrubber(request) };
}

function legacyConversation() {
  return [
    { info: { id: "msg_1", role: "user", sessionID: "ses_1" }, parts: [{ id: "prt_1", type: "text", text: "Sign in to the billing site for me." }] },
    {
      info: { id: "msg_2", role: "assistant", sessionID: "ses_1", providerID: "anthropic", modelID: "claude" },
      parts: [
        { id: "prt_2", type: "reasoning", text: `The page showed ${PASSWORD} back.`, metadata: { anthropic: { signature: "sig" } } },
        {
          id: "prt_3", type: "tool", tool: "bash", callID: "call_1",
          state: {
            status: "completed", title: "printenv",
            input: { command: `echo ${PASSWORD}`, env: { [PASSWORD]: "as a key", nested: [`--code=${CODE}`] } },
            output: `PASSWORD=${PASSWORD}\nbase64 ${ENCODED}\ncode ${CODE}`,
            metadata: { exit: 0 },
          },
        },
        { id: "prt_4", type: "text", text: `Your code is ${CODE}.` },
      ],
    },
  ];
}

test("while nothing is held, one question is asked and nothing is sent or changed", async () => {
  const { scrub, sent } = held();
  const messages = legacyConversation();
  const before = JSON.stringify(messages);
  assert.equal(await scrub([messages], OUTGOING), 0);
  assert.deepEqual(sent, [null]);
  assert.equal(JSON.stringify(messages), before);
});

test("a conversation with no text to check asks nothing", async () => {
  const { scrub, sent } = held(PASSWORD);
  assert.equal(await scrub([[{ info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "ok" }] }]], OUTGOING), 0);
  assert.deepEqual(sent, []);
});

test("every held value is gone from what goes to the model, in text, tool input, tool output, keys and encodings", async () => {
  const { scrub } = held(PASSWORD, CODE);
  const messages = legacyConversation();
  assert.ok(await scrub([messages], OUTGOING) > 0);
  const out = JSON.stringify(messages);
  for (const value of [PASSWORD, CODE, ENCODED]) assert.ok(!out.includes(value), value);
  const [user, assistant] = messages;
  assert.equal(user?.parts[0]?.text, "Sign in to the billing site for me.");
  const tool = assistant?.parts[1];
  assert.deepEqual(tool && "state" in tool ? tool.state.input : null, { command: "echo [secret]", env: { nested: ["--code=[secret]"], "[secret]": "as a key" } });
  assert.equal(assistant?.parts[2]?.text, "Your code is [secret].");
});

test("what a message is, who sent it and which tool ran are never rewritten, even when a held value spells the same", async () => {
  const { scrub } = held("user", "bash", "text", "call_1", "tool", "completed");
  const messages = legacyConversation();
  await scrub([messages], OUTGOING);
  const [user, assistant] = messages;
  assert.deepEqual(user?.info, { id: "msg_1", role: "user", sessionID: "ses_1" });
  assert.equal(user?.parts[0]?.type, "text");
  const tool = assistant?.parts[1];
  assert.ok(tool && "state" in tool);
  assert.equal(tool.type, "tool");
  assert.equal(tool.tool, "bash");
  assert.equal(tool.callID, "call_1");
  assert.equal(tool.state.status, "completed");
  assert.deepEqual(tool.state.metadata, { exit: 0 });
  assert.equal(tool.state.title, "printenv");
});

test("a picture or a binary attachment is left whole, and a text attachment is checked", async () => {
  const { scrub } = held("iVBO", PASSWORD);
  const picture = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABiVBO";
  const parts = [
    { type: "file", mime: "image/png", url: picture },
    { type: "file", mime: "text/plain", url: `data:text/plain;base64,${ENCODED}` },
    { type: "media", media: { source: { type: "base64", mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABiVBO" } } },
    { type: "media", media: { source: { type: "base64", mediaType: "application/pdf", data: `JVBERi0x${ENCODED}` } } },
    { type: "media", media: { source: { type: "text", mediaType: "text/plain", data: `notes ${PASSWORD}` } } },
  ];
  await scrub([parts], OUTGOING);
  assert.equal(parts[0]?.url, picture);
  assert.ok(!parts[1]?.url?.includes(ENCODED));
  assert.equal(parts[2]?.media?.source.data, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABiVBO");
  assert.equal(parts[3]?.media?.source.data, `JVBERi0x${ENCODED}`);
  assert.equal(parts[4]?.media?.source.data, "notes [secret]");
});

test("the newer engine's messages are changed in place: system text, tool calls and each kind of tool result", async () => {
  class Message { constructor(readonly role: string, public content: unknown[]) {} }
  const { scrub } = held(PASSWORD, "bash");
  const system = [{ type: "text", text: `Rules. Never repeat ${PASSWORD}.`, metadata: { experimental: { instructions: [{ key: "a", text: "kept" }] } } }];
  const messages = [
    new Message("user", [{ type: "text", text: `my password is ${PASSWORD}` }]),
    new Message("assistant", [
      { type: "reasoning", text: `thinking about ${PASSWORD}`, encrypted: "opaque" },
      { type: "tool-call", id: "call_1", name: "bash", namespace: "bash", input: { command: `echo ${PASSWORD}` } },
    ]),
    new Message("tool", [
      { type: "tool-result", id: "call_1", name: "bash", result: { type: "text", value: `out ${PASSWORD}` } },
      { type: "tool-result", id: "call_2", name: "bash", result: { type: "json", value: { rows: [{ [PASSWORD]: PASSWORD }] } } },
      { type: "tool-result", id: "call_3", name: "bash", result: { type: "error", value: `failed with ${PASSWORD}` } },
      { type: "tool-result", id: "call_4", name: "bash", result: { type: "content", value: [{ type: "text", text: `shown ${PASSWORD}` }, { type: "media", mediaType: "image/png", data: "iVBORw0KGgo" }] } },
    ]),
  ];
  assert.ok(await scrub([system, messages], OUTGOING) > 0);
  assert.ok(!JSON.stringify([system, messages]).includes(PASSWORD));
  assert.ok(messages.every(message => message instanceof Message));
  assert.equal(system[0]?.text, "Rules. Never repeat [secret].");
  assert.deepEqual(messages[1]?.content[1], { type: "tool-call", id: "call_1", name: "bash", namespace: "bash", input: { command: "echo [secret]" } });
  assert.deepEqual(messages[2]?.content[1], { type: "tool-result", id: "call_2", name: "bash", result: { type: "json", value: { rows: [{ "[secret]": "[secret]" }] } } });
  assert.deepEqual(messages[2]?.content[3], { type: "tool-result", id: "call_4", name: "bash", result: { type: "content", value: [{ type: "text", text: "shown [secret]" }, { type: "media", mediaType: "image/png", data: "iVBORw0KGgo" }] } });
});

test("a text that appears many times is sent once, and a long conversation goes in several requests", async () => {
  const { scrub, sent } = held(PASSWORD);
  const repeated = Array.from({ length: 50 }, () => ({ type: "text", text: `again ${PASSWORD}` }));
  await scrub([repeated], OUTGOING);
  assert.deepEqual(sent, [null, [`again ${PASSWORD}`]]);
  assert.ok(repeated.every(part => part.text === "again [secret]"));

  sent.length = 0;
  const many = Array.from({ length: 9_001 }, (_, index) => ({ type: "text", text: `line ${index} ${PASSWORD}` }));
  await scrub([many], OUTGOING);
  assert.deepEqual(sent.map(texts => texts?.length ?? null), [null, 4_000, 4_000, 1_001]);
  assert.ok(many.every((part, index) => part.text === `line ${index} [secret]`));

  sent.length = 0;
  const large = Array.from({ length: 3 }, (_, index) => ({ type: "text", text: `${String(index).repeat(5_000_000)} ${PASSWORD}` }));
  await scrub([large], OUTGOING);
  assert.deepEqual(sent.map(texts => texts?.length ?? null), [null, 1, 1, 1]);
  assert.ok(large.every(part => part.text.endsWith(" [secret]")));
});

test("with no app to ask, nothing is held back until a value has been held; after that nothing unchecked is sent", async () => {
  let mode: "down" | "up" | "broken" = "down";
  const secrets = createBrowserSecrets();
  secrets.remember(PASSWORD);
  const scrub = createPrivateValueScrubber(async texts => {
    if (mode === "down") return null;
    if (mode === "broken") throw new Error("connection lost");
    return texts ? { held: true, texts: texts.map(text => secrets.redactText(text)) } : { held: true };
  });
  const fresh = () => [{ type: "text", text: `echo ${PASSWORD}` }];
  assert.equal(await scrub([fresh()], OUTGOING), 0);
  mode = "up";
  assert.equal(await scrub([fresh()], OUTGOING), 1);
  for (mode of ["down", "broken"] as const) {
    const parts = fresh();
    await assert.rejects(scrub([parts], OUTGOING), { message: UNCHECKED });
  }
});

test("an answer that does not cover every text sent is not taken as checked", async () => {
  for (const answer of [{ held: true }, { held: true, texts: [] }, { held: false, texts: ["x"] }, null]) {
    const scrub = createPrivateValueScrubber(async texts => (texts ? answer : { held: true }));
    await assert.rejects(scrub([[{ type: "text", text: `echo ${PASSWORD}` }]], OUTGOING), { message: UNCHECKED });
  }
  const failing = createPrivateValueScrubber(async texts => {
    if (texts) throw new Error(`lost ${PASSWORD}`);
    return { held: true };
  });
  await assert.rejects(failing([[{ type: "text", text: `echo ${PASSWORD}` }]], OUTGOING), (error: unknown) => error instanceof Error && error.message === UNCHECKED);
});

test("a message that cannot be changed is not sent as it is", async () => {
  const { scrub } = held(PASSWORD);
  const frozen = [Object.freeze({ type: "text", text: `echo ${PASSWORD}` })];
  await assert.rejects(scrub([frozen], OUTGOING), { message: UNCHECKED });
  assert.equal(await scrub([[Object.freeze({ type: "text", text: "nothing private" })]], OUTGOING), 0);
});

test("a tool result is cleaned before it is kept: output, metadata and structured content, never its kind", async () => {
  const { scrub } = held(PASSWORD, "text");
  const legacy = { title: `ran ${PASSWORD}`, output: `PASSWORD=${PASSWORD}`, metadata: { preview: PASSWORD, [PASSWORD]: true } };
  assert.ok(await scrub([legacy], STORED) > 0);
  assert.deepEqual(legacy, { title: "ran [secret]", output: "PASSWORD=[secret]", metadata: { preview: "[secret]", "[secret]": true } });
  const content = { content: [{ type: "text", text: `shown ${PASSWORD}` }, { type: "file", mime: "image/png", uri: "file:///tmp/shot.png" }], structured: { [PASSWORD]: [PASSWORD] } };
  await scrub([content], STORED);
  assert.deepEqual(content, { content: [{ type: "text", text: "shown [secret]" }, { type: "file", mime: "image/png", uri: "file:///tmp/shot.png" }], structured: { "[secret]": ["[secret]"] } });
});

test("a plain copy shares nothing with the original and keeps what is not plain data", () => {
  const date = new Date(0);
  const original = { list: [{ text: "a" }], date, nothing: null };
  const copy = plainCopy(original);
  assert.deepEqual(copy, original);
  assert.notEqual(copy, original);
  assert.ok(typeof copy === "object" && copy !== null && "list" in copy && copy.list !== original.list);
  assert.ok(typeof copy === "object" && copy !== null && "date" in copy && copy.date === date);
});

type Hook = (event: never) => Promise<void>;
function engine() {
  const hooks = new Map<string, Hook>();
  let disposed = 0;
  const hook = async (name: string, callback: Hook) => {
    hooks.set(name, callback);
    return { dispose: async () => { disposed += 1; } };
  };
  const context: PrivateValuesContext = { session: { hook }, tool: { hook } };
  return { context, hooks, disposed: () => disposed };
}

test("the newer engine's plugin covers every call to a model and every finished tool, and lets go of them all", async () => {
  const { scrub } = held(PASSWORD);
  const { context, hooks, disposed } = engine();
  const dispose = await registerPrivateValues(context, scrub);
  assert.deepEqual([...hooks.keys()].sort(), ["compaction", "context", "execute.after", "execute.before", "generate", "title"]);
  for (const name of ["context", "compaction", "generate", "title"]) {
    const event = { system: [{ type: "text", text: `system ${PASSWORD}` }], messages: [{ role: "user", content: [{ type: "text", text: `user ${PASSWORD}` }] }] };
    await hooks.get(name)?.(event as never);
    assert.ok(!JSON.stringify(event).includes(PASSWORD), name);
  }
  await dispose();
  assert.equal(disposed(), 6);
});

test("the newer engine keeps a cleaned copy of a tool result, and the original when there was nothing to clean", async () => {
  const { scrub } = held(PASSWORD);
  const { context, hooks } = engine();
  await registerPrivateValues(context, scrub);
  const after = hooks.get("execute.after");
  const result = Object.freeze({ output: Object.freeze({ stdout: `PASSWORD=${PASSWORD}` }), content: `PASSWORD=${PASSWORD}`, metadata: Object.freeze({ exit: 0 }) });
  const finished = { status: "completed", result: result as unknown };
  await after?.(finished as never);
  assert.notEqual(finished.result, result);
  assert.deepEqual(finished.result, { output: { stdout: "PASSWORD=[secret]" }, content: "PASSWORD=[secret]", metadata: { exit: 0 } });
  assert.equal(result.content, `PASSWORD=${PASSWORD}`);

  const clean = { output: "nothing private" };
  const untouched = { status: "completed", result: clean as unknown };
  await after?.(untouched as never);
  assert.equal(untouched.result, clean);

  const failed = { status: "error", error: { message: PASSWORD } };
  await after?.(failed as never);
  assert.deepEqual(failed, { status: "error", error: { message: PASSWORD } });
});

test("a finished tool is never failed by the check; the call to the model is what holds it back", async () => {
  let up = true;
  const scrub = createPrivateValueScrubber(async texts => {
    if (!up) return null;
    return texts ? { held: true, texts: texts.map(() => "[secret]") } : { held: true };
  });
  const { context, hooks } = engine();
  await registerPrivateValues(context, scrub);
  const warm = { status: "completed", result: { output: PASSWORD } as unknown };
  await hooks.get("execute.after")?.(warm as never);
  assert.deepEqual(warm.result, { output: "[secret]" });
  up = false;
  const original = { output: PASSWORD };
  const kept = { status: "completed", result: original as unknown };
  await hooks.get("execute.after")?.(kept as never);
  assert.equal(kept.result, original);
  await assert.rejects(Promise.resolve(hooks.get("context")?.({ system: [], messages: [{ role: "user", content: [{ type: "text", text: PASSWORD }] }] } as never)), { message: UNCHECKED });
});

test("the newer engine refuses a program used for private values in the agent's terminal only while the app says the organization blocks it", async () => {
  const { context, hooks } = engine();
  let asked = 0;
  let answer: { blocked: boolean; source: string; programs: string[] } | null = { blocked: true, source: "Everyone", programs: ["bw", "vault-cli"] };
  await registerPrivateValues(context, async () => 0, async () => { asked += 1; return answer; });
  const before = hooks.get("execute.before");
  assert.ok(before);
  const run = (tool: string, command: string) => before({ tool, input: { command } } as never);

  await run("read", "bw get password billing");
  assert.equal(asked, 0);
  await run("shell", "echo hello");
  await run("shell", "op read op://vault/item/password");
  assert.equal(asked, 2);

  await assert.rejects(run("shell", "/opt/homebrew/bin/bw get password billing"), (error: Error) => error.message.includes("Everyone") && error.message.includes("fill_from"));
  await assert.rejects(run("shell", "echo $(vault-cli read prod/db)"));

  answer = { blocked: false, source: "Everyone", programs: ["bw"] };
  await run("shell", "bw get password billing");
  answer = null;
  await run("shell", "bw get password billing");
  assert.equal(asked, 6);
});
