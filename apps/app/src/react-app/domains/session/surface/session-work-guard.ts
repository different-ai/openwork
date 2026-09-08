import type { Message } from "@opencode-ai/sdk/v2/client";
import type { Client } from "@/app/types";

// Scope stops to the owning runtime, not the workspace currently on screen.
const guards = new Map<string, {
  generation: number;
  blocked: boolean;
  sends: Set<Promise<unknown>>;
  commands: Set<string>;
}>();

function guardFor(baseUrl: string, sessionId: string) {
  const key = JSON.stringify([baseUrl.replace(/\/+$/, ""), sessionId]);
  let guard = guards.get(key);
  if (!guard) {
    guard = { generation: 0, blocked: false, sends: new Set(), commands: new Set() };
    guards.set(key, guard);
  }
  return guard;
}

export function isSessionWorkBlocked(baseUrl: string, sessionId: string) {
  return guardFor(baseUrl, sessionId).blocked;
}

export function sessionSendIsCurrent(baseUrl: string, sessionId: string) {
  const guard = guardFor(baseUrl, sessionId);
  const generation = guard.generation;
  return () => !guard.blocked && guard.generation === generation;
}

export async function trackSessionSend<T>(baseUrl: string, sessionId: string, send: () => Promise<T>): Promise<T> {
  const guard = guardFor(baseUrl, sessionId);
  if (guard.blocked) throw new Error("This session is being archived. Try again after restoring it.");
  const pending = send();
  guard.sends.add(pending);
  try {
    return await pending;
  } finally {
    guard.sends.delete(pending);
  }
}

export function hasPendingSessionSend(baseUrl: string, sessionId: string) {
  return guardFor(baseUrl, sessionId).sends.size > 0;
}

export function blockSessionWork(baseUrl: string, sessionId: string) {
  const guard = guardFor(baseUrl, sessionId);
  guard.blocked = true;
  guard.generation += 1;
}

export function releaseSessionWork(baseUrl: string, sessionId: string) {
  guardFor(baseUrl, sessionId).blocked = false;
}

export async function settleSessionSends(baseUrl: string, sessionId: string) {
  // New sends are blocked before this snapshot. A late failed send retains its
  // old generation even after Undo, so it cannot put cancelled work back.
  await Promise.allSettled([...guardFor(baseUrl, sessionId).sends]);
}

export function queuedMessageId(itemId: string) {
  return `msg_${itemId.replaceAll("-", "")}`;
}

type AdmissionMessage = { info: Pick<Message, "id" | "role" | "time"> & { parentID?: string } };

export function hasTerminalReply(messages: readonly AdmissionMessage[], messageId: string) {
  return messages.some(({ info }) => info.role === "assistant"
    && info.parentID === messageId && "completed" in info.time && typeof info.time.completed === "number");
}

export async function sendTrackedSessionCommand(
  baseUrl: string,
  client: Client,
  parameters: Parameters<Client["session"]["command"]>[0],
) {
  const messageID = parameters.messageID ?? queuedMessageId(crypto.randomUUID());
  const guard = guardFor(baseUrl, parameters.sessionID);
  if (guard.blocked) throw new Error("Session send cancelled by archive.");
  // The proxy acknowledges before dispatch. Neither that response nor idle is
  // proof of execution: keep the ID until the engine exposes its fate.
  guard.commands.add(messageID);
  const result = await client.session.command({ ...parameters, messageID });
  if (result.response.status >= 400 && result.response.status < 500) guard.commands.delete(messageID);
  return result;
}

export function reconcileSessionCommands(baseUrl: string, sessionId: string, messages: readonly AdmissionMessage[]) {
  const commands = guardFor(baseUrl, sessionId).commands;
  for (const messageId of commands) {
    if (hasTerminalReply(messages, messageId)) commands.delete(messageId);
  }
  return {
    pending: commands.size > 0,
    unobserved: [...commands].some(messageId => !messages.some(({ info }) => info.id === messageId)),
  };
}

export function confirmSessionCommandsStopped(baseUrl: string, sessionId: string) {
  guardFor(baseUrl, sessionId).commands.clear();
}
