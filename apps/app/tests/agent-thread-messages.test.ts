import { expect, test } from "bun:test";
import type { PersonalAgentChatTurn } from "@openwork/types/den/personal-agents";

import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "../src/app/types";
import { agentThreadMessages, agentThreadTimeline } from "../src/react-app/domains/agents/agent-thread-messages";

const turn: PersonalAgentChatTurn = {
  id: "turn-1",
  clientMessageId: "client-1",
  message: "Check the notes",
  reply: null,
  error: null,
  status: "running",
  createdAt: "2026-11-26T18:00:00.000Z",
  finishedAt: null,
};

const pending = { clientMessageId: turn.clientMessageId, message: turn.message, createdAt: Date.parse(turn.createdAt) };

test("confirmation replaces the optimistic user message without changing its identity", () => {
  const optimistic = agentThreadMessages([], pending);
  const confirmed = agentThreadMessages([turn], pending);
  expect(confirmed).toEqual(optimistic);
  expect(confirmed).toHaveLength(1);
});

test("rich replies preserve part order, tool duration and running state", () => {
  const [user, reply] = agentThreadMessages([{
    ...turn,
    parts: [
      { type: "reasoning", text: "Reading the notes", durationMs: 1_500 },
      { type: "tool", id: "part-1", name: "read", status: "running", input: null, output: null, error: null, truncated: false, startedAt: 100 },
      { type: "text", text: "The notes contain **three items**." },
    ],
  }], null);
  expect(user.role).toBe("user");
  expect(reply.id).toBe("agent-reply:turn-1");
  expect(reply.parts.map((part) => part.type)).toEqual(["reasoning", "dynamic-tool", "text"]);
  expect(reply.parts[1]).toMatchObject({ type: "dynamic-tool", state: "input-available", callProviderMetadata: { openwork: { toolStartedAt: 100 } } });
  expect(reply.parts[2]).toMatchObject({ text: "The notes contain **three items**." });
});

test("bounded runner parts cannot replace or duplicate the complete saved reply", () => {
  const reply = "Here are all three notes, in order, with their dates.";
  const [, assistant] = agentThreadMessages([{
    ...turn,
    status: "succeeded",
    reply,
    parts: [
      { type: "text", text: "Checking your notes." },
      { type: "tool", id: "part-1", name: "read", status: "completed", input: null, output: null, error: null, truncated: false },
      { type: "text", text: "Here are all three notes" },
    ],
  }], null);
  expect(assistant.parts.map((part) => part.type)).toEqual(["dynamic-tool", "text"]);
  expect(assistant.parts[1]).toMatchObject({ type: "text", text: reply });
});

test("legacy answers stay visible and turn failures do not reveal raw provider errors", () => {
  const finishedAt = "2026-11-26T18:00:04.000Z";
  const [, reply, error] = agentThreadMessages([{
    ...turn,
    finishedAt,
    status: "failed",
    reply: "Partial answer",
    error: "private provider text",
  }], null);
  expect(reply.parts[0]).toMatchObject({ type: "text", text: "Partial answer" });
  expect(reply.metadata).toEqual({ opencode: { created: Date.parse(turn.createdAt), completed: Date.parse(finishedAt) } });
  expect(error.id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX)).toBe(true);
  expect(JSON.stringify(error)).not.toContain("private provider text");
});

test("routine runs sit between chat turns by time, and a new message goes last", () => {
  const at = (iso: string) => ({ ...turn, id: iso, clientMessageId: iso, status: "succeeded" as const, reply: "ok", createdAt: iso });
  const runs = [{ id: "run-early", createdAt: Date.parse("2026-11-26T09:00:00.000Z") }, { id: "run-late", createdAt: Date.parse("2026-11-26T20:00:00.000Z") }];
  const items = agentThreadTimeline([at("2026-11-26T10:00:00.000Z"), at("2026-11-26T11:00:00.000Z"), at("2026-11-26T19:00:00.000Z")], runs,
    { clientMessageId: "new", message: "Hi", createdAt: Date.parse("2026-11-26T21:00:00.000Z") });
  expect(items.map((item) => item.kind === "run" ? item.run.id : item.messages.filter((m) => m.role === "user").length))
    .toEqual(["run-early", 3, "run-late", 1]);
});

test("an answered request sits where it was answered, so later messages come after it", () => {
  const at = (iso: string) => ({ ...turn, id: iso, clientMessageId: iso, status: "succeeded" as const, reply: "ok", createdAt: iso });
  const requests = [{ id: "ask", createdAt: "2026-11-26T10:00:30.000Z", decidedAt: "2026-11-26T10:30:00.000Z" }];
  const items = agentThreadTimeline([at("2026-11-26T10:00:00.000Z"), at("2026-11-26T11:00:00.000Z")], [], null, requests);
  expect(items.map((item) => item.kind)).toEqual(["chat", "request", "chat"]);
});
