import { describe, expect, test } from "bun:test";

import { engineEventEnvelopeSchema, sessionMessageSchema, sessionSnapshotSchema } from "./schemas";
import type { EngineEvent, EngineGlobalEventEnvelope, Message, Part, Session, SessionStatus, Todo } from "./index";

const sessionFixture = {
  id: "ses_1",
  slug: "hostname-check",
  projectID: "proj_1",
  workspaceID: "ws_1",
  directory: "/tmp/openwork-fixture",
  title: "Hostname Check",
  version: "1.0.0",
  time: { created: 100, updated: 250 },
  summary: { additions: 1, deletions: 0, files: 1 },
  model: { id: "claude-sonnet-4", providerID: "anthropic" },
  revert: { messageID: "msg_1", partID: "prt_tool" },
} satisfies Session;

const assistantMessage = {
  id: "msg_1",
  sessionID: "ses_1",
  role: "assistant",
  parentID: "msg_0",
  modelID: "claude-sonnet-4",
  providerID: "anthropic",
  mode: "build",
  agent: "build",
  path: { cwd: "/tmp/openwork-fixture", root: "/tmp/openwork-fixture" },
  cost: 0.01,
  tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 0, write: 0 } },
  time: { created: 200, completed: 250 },
} satisfies Message;

const textPart = {
  id: "prt_text",
  sessionID: "ses_1",
  messageID: "msg_1",
  type: "text",
  text: "hostname: mock-host",
  time: { start: 210, end: 220 },
} satisfies Part;

const reasoningPart = {
  id: "prt_reasoning",
  sessionID: "ses_1",
  messageID: "msg_1",
  type: "reasoning",
  text: "Need to inspect hostname.",
  time: { start: 205, end: 209 },
} satisfies Part;

const filePart = {
  id: "prt_file",
  sessionID: "ses_1",
  messageID: "msg_1",
  type: "file",
  mime: "text/plain",
  filename: "hostname.txt",
  url: "file:///tmp/openwork-fixture/hostname.txt",
  source: {
    type: "file",
    path: "hostname.txt",
    text: { value: "mock-host", start: 0, end: 9 },
  },
} satisfies Part;

const toolPart = {
  id: "prt_tool",
  sessionID: "ses_1",
  messageID: "msg_1",
  type: "tool",
  callID: "call_1",
  tool: "bash",
  state: {
    status: "completed",
    input: { command: "hostname" },
    output: "mock-host",
    title: "hostname",
    metadata: { exitCode: 0 },
    time: { start: 215, end: 225 },
    attachments: [filePart],
  },
} satisfies Part;

const todoFixture = {
  content: "Validate session reads",
  status: "completed",
  priority: "high",
} satisfies Todo;

const statusFixture = { type: "busy" } satisfies SessionStatus;

describe("engine protocol schemas", () => {
  test("round-trips the read-model session snapshot", () => {
    const message = { info: assistantMessage, parts: [reasoningPart, textPart, toolPart, filePart] };
    const snapshot = {
      session: sessionFixture,
      messages: [message],
      todos: [todoFixture],
      status: statusFixture,
    };

    expect(sessionMessageSchema.parse(message)).toEqual(message);
    expect(sessionSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  test("round-trips direct and directory-wrapped engine events", () => {
    const event = {
      id: "evt_1",
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: toolPart,
        time: 225,
      },
    } satisfies EngineEvent;
    const envelope = {
      directory: "/tmp/openwork-fixture",
      payload: event,
    } satisfies EngineGlobalEventEnvelope;

    expect(engineEventEnvelopeSchema.parse(event)).toEqual(event);
    expect(engineEventEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });
});
