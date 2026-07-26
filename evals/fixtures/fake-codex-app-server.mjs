#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

if (process.argv.includes("--version")) {
  console.log("codex-cli 9.9.9-fraimz");
  process.exit(0);
}

let account = null;
let loginStarted = false;
let loginReads = 0;
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
    status: {
      type: pendingTurn?.status === "inProgress" ? "active" : "idle",
      activeFlags: pendingTurn?.status === "inProgress" ? ["waitingForApproval"] : [],
    },
    path: null,
    cwd: process.cwd(),
    cliVersion: "9.9.9-fraimz",
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
    description: "Codex on the remote OpenWork worker",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "high", description: "High" },
    ],
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
  writeFileSync("server-proof.md", "created on the remote worker\n", "utf8");
  const command = {
    id: "item_command_1",
    type: "commandExecution",
    command: "hostname",
    cwd: process.cwd(),
    processId: null,
    status: "completed",
    commandActions: [],
    aggregatedOutput: "openwork-remote-worker\n",
    exitCode: 0,
    durationMs: 5,
  };
  const fileChange = {
    id: "item_file_1",
    type: "fileChange",
    changes: [{ path: "server-proof.md", kind: "add", diff: "+created on the remote worker" }],
    status: "completed",
  };
  const answer = {
    id: "item_answer_1",
    type: "agentMessage",
    text: "Done on the remote worker. I ran hostname and created server-proof.md.",
    phase: "final_answer",
  };
  pendingTurn.items = [pendingTurn.items[0], command, fileChange, answer];
  pendingTurn.status = "completed";
  pendingTurn.completedAt = epoch + 1;
  pendingTurn.durationMs = 1_000;
  send({
    method: "item/completed",
    params: {
      threadId: "thread_remote_1",
      turnId: "turn_1",
      item: command,
      completedAtMs: (epoch + 1) * 1_000,
    },
  });
  send({
    method: "item/completed",
    params: {
      threadId: "thread_remote_1",
      turnId: "turn_1",
      item: fileChange,
      completedAtMs: (epoch + 1) * 1_000,
    },
  });
  send({
    method: "item/started",
    params: {
      threadId: "thread_remote_1",
      turnId: "turn_1",
      item: answer,
      startedAtMs: (epoch + 1) * 1_000,
    },
  });
  send({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread_remote_1",
      turnId: "turn_1",
      itemId: "item_answer_1",
      delta: answer.text,
    },
  });
  send({
    method: "item/completed",
    params: {
      threadId: "thread_remote_1",
      turnId: "turn_1",
      item: answer,
      completedAtMs: (epoch + 1) * 1_000,
    },
  });
  send({
    method: "turn/completed",
    params: { threadId: "thread_remote_1", turn: pendingTurn },
  });
  send({
    method: "thread/status/changed",
    params: { threadId: "thread_remote_1", status: { type: "idle" } },
  });
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
      send({
        id,
        result: {
          userAgent: "codex-cli/9.9.9-fraimz",
          codexHome: process.env.CODEX_HOME,
          platformFamily: "unix",
          platformOs: "linux",
        },
      });
      return;
    case "account/read":
      if (loginStarted && !account) {
        loginReads += 1;
        if (loginReads >= 5) {
          account = {
            type: "chatgpt",
            email: "server@example.test",
            planType: "plus",
          };
        }
      }
      send({ id, result: { account, requiresOpenaiAuth: true } });
      return;
    case "account/login/start":
      loginStarted = true;
      loginReads = 0;
      send({
        id,
        result: {
          type: "chatgptDeviceCode",
          loginId: "login_fraimz",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "OPEN-WORK",
        },
      });
      return;
    case "account/login/cancel":
      loginStarted = false;
      loginReads = 0;
      send({ id, result: {} });
      return;
    case "account/logout":
      account = null;
      loginStarted = false;
      loginReads = 0;
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
      send({
        method: "thread/name/updated",
        params: {
          threadId: "thread_remote_1",
          threadName: message.params.name,
        },
      });
      return;
    case "thread/list":
      send({
        id,
        result: { data: thread ? [makeThread()] : [], nextCursor: null },
      });
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
      const userText =
        message.params.input.find((item) => item.type === "text")?.text || "";
      const user = {
        id: "item_user_1",
        type: "userMessage",
        content: [{ type: "text", text: userText }],
      };
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
      send({
        method: "thread/status/changed",
        params: {
          threadId: "thread_remote_1",
          status: { type: "active", activeFlags: [] },
        },
      });
      send({
        method: "turn/started",
        params: { threadId: "thread_remote_1", turn: pendingTurn },
      });
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
        send({
          method: "item/started",
          params: {
            threadId: "thread_remote_1",
            turnId: "turn_1",
            item: command,
            startedAtMs: epoch * 1_000,
          },
        });
        send({
          id: 900,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread_remote_1",
            turnId: "turn_1",
            itemId: "item_command_1",
            command: "hostname",
            cwd: process.cwd(),
            reason: "Confirm execution on the remote worker",
          },
        });
      }, 2_500);
      return;
    }
    case "turn/interrupt":
      send({ id, result: {} });
      return;
    default:
      send({
        id,
        error: {
          code: -32601,
          message: "Unsupported fake method " + message.method,
        },
      });
  }
});

process.on("SIGTERM", () => process.exit(0));
