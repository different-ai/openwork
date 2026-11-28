import { expect, test } from "bun:test";
import plugin, { releaseCloudCodingTurns } from "../src/opencode-plugins/openwork-mcp-results-v2.js";

type Context = Parameters<typeof plugin.setup>[0];
type ToolEditor = Parameters<Parameters<Context["tool"]["transform"]>[0]>[0];
type Tool = Parameters<Parameters<ToolEditor["update"]>[1]>[0];

async function fixture(event?: Context["event"]) {
  const name = "openwork-cloud_execute_capability";
  const tool: Tool = { execute: async input => ({ output: input }) };
  const disposal = { dispose: async () => {} };
  const seen: string[] = [];
  const cleanup = await plugin.setup({
    event,
    session: { get: async ({ sessionID }) => {
      seen.push(sessionID);
      return { parentID: sessionID === "child" ? "parent" : sessionID === "parent" ? "root" : undefined };
    } },
    tool: {
      transform: async transform => {
        transform({ get: () => undefined, list: () => [{ id: name }], update: (_id, edit) => edit(tool) });
        return disposal;
      },
      hook: async () => disposal,
    },
  });
  return { seen, cleanup, execute: async (input: unknown, sessionID: string) => (await tool.execute(input, {
    sessionID, id: "call", messageID: "message", progress: async () => {},
  })).output };
}

test("cloud-coding:start overwrites model-supplied origin in either supported argument shape", async () => {
  const f = await fixture();
  try {
    const args = { repository: "example/project", task: "Fix the layout", originSessionId: "model-supplied" };
    expect(await f.execute({ name: "cloud-coding:start", body: args }, "root")).toEqual({ name: "cloud-coding:start", body: { ...args, originSessionId: "root" } });
    expect(await f.execute({ name: "cloud-coding:start", arguments: args, body: { fallback: true } }, "child")).toEqual({
      name: "cloud-coding:start", arguments: { ...args, originSessionId: "root" }, body: { fallback: true },
    });
    expect(f.seen).toEqual(["root", "child", "parent", "root"]);
  } finally {
    await f.cleanup();
  }
});

test("cloud-coding:status and unrelated capabilities are unchanged", async () => {
  const f = await fixture();
  try {
    for (const name of ["cloud-coding:status", "cloud-coding:repositories", "other:capability"]) {
      const input = { name, body: { originSessionId: "untouched" }, arguments: { taskId: "task-one" } };
      expect(await f.execute(input, "child")).toBe(input);
    }
    expect(f.seen).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test("turn release ignores child executions and non-terminal events", async () => {
  async function* events() {
    yield { type: "session.execution.started", data: { sessionID: "root" } };
    yield { type: "session.execution.succeeded", data: { sessionID: "child" } };
    yield { type: "session.execution.succeeded", data: { sessionID: "root" } };
    yield { type: "session.execution.failed", data: { sessionID: "second-root" } };
    yield { type: "session.execution.interrupted", data: { sessionID: "third-root" } };
  }
  const released: string[] = [];
  await releaseCloudCodingTurns(events(), async id => id === "child" ? "root" : id, async id => { released.push(id); });
  expect(released).toEqual(["root", "second-root", "third-root"]);
});

test("only Web subscribes the V2 plugin to terminal execution events", async () => {
  const previous = process.env.OPENWORK_RUNTIME_SURFACE;
  const calls: { types: string[]; signal: AbortSignal }[] = [];
  const event: Context["event"] = { async *subscribe(options) { calls.push(options); } };
  try {
    delete process.env.OPENWORK_RUNTIME_SURFACE;
    await (await fixture(event)).cleanup();
    expect(calls).toHaveLength(0);
    process.env.OPENWORK_RUNTIME_SURFACE = "web";
    await (await fixture(event)).cleanup();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.types).toEqual(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);
    expect(calls[0]?.signal.aborted).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_RUNTIME_SURFACE;
    else process.env.OPENWORK_RUNTIME_SURFACE = previous;
  }
});
