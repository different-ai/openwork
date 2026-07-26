import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const stops: Array<() => void | Promise<void>> = [];
const previousCodexBin = process.env.OPENWORK_CODEX_BIN;
const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
  if (previousCodexBin === undefined) delete process.env.OPENWORK_CODEX_BIN;
  else process.env.OPENWORK_CODEX_BIN = previousCodexBin;
  if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
  else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
});

async function createFakeCodex(root: string): Promise<string> {
  const path = join(root, "fake-codex.mjs");
  const source = String.raw`#!/usr/bin/env bun
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  console.log("codex-cli 9.9.9-test");
  process.exit(0);
}

let account = null;
let thread = null;
let pendingTurn = null;
const epoch = 1_700_000_000;

function send(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function makeThread() {
  return {
    id: "thread_remote_1",
    sessionId: "thread_remote_1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "Inspect the remote worker",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: epoch,
    updatedAt: epoch,
    recencyAt: epoch,
    status: { type: pendingTurn ? "active" : "idle", activeFlags: pendingTurn ? ["waitingForApproval"] : [] },
    path: null,
    cwd: process.cwd(),
    cliVersion: "9.9.9-test",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "Remote Codex check",
    turns: pendingTurn ? [pendingTurn] : [],
  };
}

function model() {
  return {
    id: "gpt-5.6-codex",
    model: "gpt-5.6-codex",
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: "GPT-5.6 Codex",
    description: "Test Codex model",
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
    defaultReasoningEffort: "high",
    inputModalities: ["text", "image"],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
  };
}

function completeApprovedTurn() {
  if (!pendingTurn) return;
  const command = {
    id: "item_command_1",
    type: "commandExecution",
    command: "hostname",
    cwd: process.cwd(),
    processId: null,
    status: "completed",
    commandActions: [],
    aggregatedOutput: "remote-worker-test\n",
    exitCode: 0,
    durationMs: 5,
  };
  const fileChange = {
    id: "item_file_1",
    type: "fileChange",
    changes: [{ path: "server-proof.txt", kind: { type: "add" }, diff: "+created remotely" }],
    status: "completed",
  };
  const answer = {
    id: "item_answer_1",
    type: "agentMessage",
    text: "The command ran on remote-worker-test.",
    phase: "final_answer",
  };
  pendingTurn.items = [pendingTurn.items[0], command, fileChange, answer];
  pendingTurn.status = "completed";
  pendingTurn.completedAt = epoch + 1;
  pendingTurn.durationMs = 1_000;
  send({ method: "item/completed", params: { threadId: "thread_remote_1", turnId: "turn_1", item: command, completedAtMs: (epoch + 1) * 1000 } });
  send({ method: "item/completed", params: { threadId: "thread_remote_1", turnId: "turn_1", item: fileChange, completedAtMs: (epoch + 1) * 1000 } });
  send({ method: "item/started", params: { threadId: "thread_remote_1", turnId: "turn_1", item: answer, startedAtMs: (epoch + 1) * 1000 } });
  send({ method: "item/agentMessage/delta", params: { threadId: "thread_remote_1", turnId: "turn_1", itemId: "item_answer_1", delta: answer.text } });
  send({ method: "item/completed", params: { threadId: "thread_remote_1", turnId: "turn_1", item: answer, completedAtMs: (epoch + 1) * 1000 } });
  send({ method: "turn/completed", params: { threadId: "thread_remote_1", turn: pendingTurn } });
  send({ method: "thread/status/changed", params: { threadId: "thread_remote_1", status: { type: "idle" } } });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 900 && !message.method) {
    completeApprovedTurn();
    return;
  }
  if (!message.method || message.method === "initialized") return;
  const id = message.id;
  switch (message.method) {
    case "initialize":
      send({ id, result: { userAgent: "codex-cli/9.9.9-test", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "linux" } });
      return;
    case "account/read":
      send({ id, result: { account, requiresOpenaiAuth: true } });
      return;
    case "account/login/start":
      account = { type: "chatgpt", email: "server@example.test", planType: "plus" };
      send({ id, result: { type: "chatgptDeviceCode", loginId: "login_1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" } });
      return;
    case "account/login/cancel":
      send({ id, result: {} });
      return;
    case "account/logout":
      account = null;
      send({ id, result: {} });
      return;
    case "model/list":
      send({ id, result: { data: [model()], nextCursor: null } });
      return;
    case "thread/start":
      thread = makeThread();
      send({ id, result: { thread } });
      send({ method: "thread/started", params: { thread } });
      return;
    case "thread/name/set":
      if (thread) thread.name = message.params.name;
      send({ id, result: {} });
      send({ method: "thread/name/updated", params: { threadId: "thread_remote_1", threadName: message.params.name } });
      return;
    case "thread/list":
      send({ id, result: { data: thread ? [makeThread()] : [], nextCursor: null } });
      return;
    case "thread/read":
      send({ id, result: { thread: makeThread() } });
      return;
    case "thread/delete":
      thread = null;
      pendingTurn = null;
      send({ id, result: {} });
      return;
    case "turn/start": {
      const userText = message.params.input.find((item) => item.type === "text")?.text || "";
      const user = { id: "item_user_1", type: "userMessage", content: [{ type: "text", text: userText }] };
      pendingTurn = {
        id: "turn_1",
        items: [user],
        itemsView: { type: "full" },
        status: "inProgress",
        error: null,
        startedAt: epoch,
        completedAt: null,
        durationMs: null,
      };
      send({ id, result: { turn: pendingTurn } });
      send({ method: "thread/status/changed", params: { threadId: "thread_remote_1", status: { type: "active", activeFlags: [] } } });
      send({ method: "turn/started", params: { threadId: "thread_remote_1", turn: pendingTurn } });
      setTimeout(() => {
        const command = {
          id: "item_command_1",
          type: "commandExecution",
          command: "hostname",
          cwd: process.cwd(),
          processId: null,
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: "",
          exitCode: null,
          durationMs: null,
        };
        pendingTurn.items.push(command);
        send({ method: "item/started", params: { threadId: "thread_remote_1", turnId: "turn_1", item: command, startedAtMs: epoch * 1000 } });
        send({ id: 900, method: "item/commandExecution/requestApproval", params: { threadId: "thread_remote_1", turnId: "turn_1", itemId: "item_command_1", command: "hostname", cwd: process.cwd(), reason: "Confirm remote execution" } });
      }, 5);
      return;
    }
    case "turn/interrupt":
      send({ id, result: {} });
      return;
    default:
      send({ id, error: { code: -32601, message: "Unsupported fake method " + message.method } });
  }
});

process.on("SIGTERM", () => process.exit(0));
`;
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
  return path;
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let index = 0; index < 50 && !ready(value); index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = await read();
  }
  return value;
}

describe("Codex server runtime", () => {
  test("runs ChatGPT Codex sessions and approvals on the remote worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-codex-runtime-"));
    roots.push(root);
    process.env.OPENWORK_CODEX_BIN = await createFakeCodex(root);
    process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");

    const config: ServerConfig = {
      host: "127.0.0.1",
      port: 0,
      token: "owt_codex_test",
      hostToken: "owt_codex_host",
      approval: { mode: "auto", timeoutMs: 1_000 },
      corsOrigins: ["*"],
      workspaces: [{
        id: "ws_codex",
        name: "Remote workspace",
        path: root,
        preset: "starter",
        workspaceType: "local",
        baseUrl: "http://127.0.0.1:1",
      }],
      authorizedRoots: [root],
      readOnly: false,
      startedAt: Date.now(),
      tokenSource: "cli",
      hostTokenSource: "cli",
      logFormat: "pretty",
      logRequests: false,
      configPath: join(root, "server.json"),
    };
    const server = await startServer(config);
    stops.push(() => server.stop());
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { ...auth(config.token), "Content-Type": "application/json" };

    const initial = await fetch(base + "/workspace/ws_codex/agent-runtime", { headers: auth(config.token) });
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({
      runtime: "opencode",
      available: true,
      version: "codex-cli 9.9.9-test",
      process: { running: false, transport: "stdio", placement: "remote-worker", publicPort: false },
    });

    const selected = await fetch(base + "/workspace/ws_codex/agent-runtime", {
      method: "PUT",
      headers,
      body: JSON.stringify({ runtime: "codex" }),
    });
    expect(selected.status).toBe(200);
    await expect(selected.json()).resolves.toMatchObject({
      runtime: "codex",
      process: { running: true, healthy: true, transport: "stdio", publicPort: false },
      account: { connected: false },
      defaultModel: "gpt-5.6-codex",
    });

    const login = await fetch(base + "/workspace/ws_codex/agent-runtime/codex/login", {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(login.status).toBe(201);
    await expect(login.json()).resolves.toEqual({
      loginId: "login_1",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    });

    const connected = await fetch(base + "/workspace/ws_codex/agent-runtime", { headers: auth(config.token) });
    await expect(connected.json()).resolves.toMatchObject({
      account: { connected: true, type: "chatgpt", email: "server@example.test", planType: "plus" },
    });

    const created = await fetch(base + "/workspace/ws_codex/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Remote Codex check", prompt: "Run hostname on the worker." }),
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      item: { id: "thread_remote_1", title: "Remote Codex check", directory: root },
      started: true,
    });

    const readPermissions = async () => {
      const response = await fetch(base + "/workspace/ws_codex/opencode/permission", { headers: auth(config.token) });
      return response.json();
    };
    const permissions = await waitFor(readPermissions, (value) => Array.isArray(value) && value.length === 1);
    expect(permissions).toEqual([{
      id: "codex-900",
      sessionID: "thread_remote_1",
      action: "command.execute",
      resources: ["hostname", root],
      save: ["command.execute"],
      metadata: {
        runtime: "codex",
        command: "hostname",
        cwd: root,
        reason: "Confirm remote execution",
      },
      source: { messageID: "assistant:turn_1", callID: "item_command_1" },
    }]);

    const approved = await fetch(base + "/workspace/ws_codex/opencode/permission/codex-900/reply", {
      method: "POST",
      headers,
      body: JSON.stringify({ reply: "once" }),
    });
    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toBe(true);

    const readMessages = async () => {
      const response = await fetch(base + "/workspace/ws_codex/sessions/thread_remote_1/messages", {
        headers: auth(config.token),
      });
      return response.json();
    };
    const messageResult = await waitFor(
      readMessages,
      (value) => JSON.stringify(value).includes("The command ran on remote-worker-test."),
    );
    expect(messageResult).toMatchObject({
      items: [
        { info: { role: "user" }, parts: [{ type: "text", text: "Run hostname on the worker." }] },
        {
          info: { role: "assistant", providerID: "codex" },
          parts: [
            { type: "tool", tool: "bash", state: { status: "completed", output: "remote-worker-test\n" } },
            {
              type: "tool",
              tool: "apply_patch",
              state: {
                status: "completed",
                input: { patchText: "*** Add File: server-proof.txt\n+created remotely" },
              },
            },
            { type: "text", text: "The command ran on remote-worker-test." },
          ],
        },
      ],
    });
  });
});
