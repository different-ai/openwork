import type { RemoteSessionTranscriptMessage } from "@openwork/types/automations";
import type { PersonalAgentChatTurn, SendPersonalAgentChatMessage } from "@openwork/types/den/personal-agents";
import type { UIMessage } from "ai";

import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "@/app/types";
import { t } from "@/i18n";
import { parseRemoteTranscriptMessage } from "@/lib/remote-session-thread";
import { remoteTranscriptToUIMessages } from "@/lib/remote-transcript-messages";

type PendingMessage = SendPersonalAgentChatMessage & { createdAt: number };

function userMessage(clientMessageId: string, text: string, created: number): UIMessage {
  return {
    id: `agent-user:${clientMessageId}`,
    role: "user",
    metadata: { opencode: { created } },
    parts: [{ type: "text", text }],
  };
}

export function agentThreadMessages(turns: readonly PersonalAgentChatTurn[], pending: PendingMessage | null): UIMessage[] {
  const messages: UIMessage[] = [];
  for (const turn of turns) {
    const created = Date.parse(turn.createdAt);
    messages.push(userMessage(turn.clientMessageId, turn.message, created));
    const runnerParts = turn.parts ?? [];
    const text = turn.reply ?? "";
    const parts: RemoteSessionTranscriptMessage["parts"] = text.trim()
      ? [...runnerParts.filter((part) => part.type !== "text"), { type: "text", text }]
      : runnerParts;
    const reply: RemoteSessionTranscriptMessage = {
      id: `agent-reply:${turn.id}`,
      role: "assistant",
      createdAt: created,
      completedAt: turn.finishedAt ? Date.parse(turn.finishedAt) : null,
      text,
      truncated: false,
      toolCalls: [],
      error: null,
      parts,
    };
    const normalized = parseRemoteTranscriptMessage(reply);
    if (normalized?.parts.length) {
      messages.push(...remoteTranscriptToUIMessages([normalized], { running: turn.status === "running" }));
    }
    if (turn.status === "failed") {
      messages.push({
        id: `${SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX}agent:${turn.id}`,
        role: "assistant",
        parts: [{ type: "text", text: t("agents.chat_reply_failed") }],
      });
    }
  }
  if (pending && !turns.some((turn) => turn.clientMessageId === pending.clientMessageId)) {
    messages.push(userMessage(pending.clientMessageId, pending.message, pending.createdAt));
  }
  return messages;
}

export type AgentThreadItem<Run> =
  | { kind: "chat"; key: string; messages: UIMessage[] }
  | { kind: "run"; key: string; run: Run };

export function agentThreadTimeline<Run extends { id: string; createdAt: number }>(
  turns: readonly PersonalAgentChatTurn[],
  runs: readonly Run[],
  pending: PendingMessage | null,
): AgentThreadItem<Run>[] {
  const entries = [
    ...turns.map((turn) => ({ at: Date.parse(turn.createdAt), turn, run: null })),
    ...runs.map((run) => ({ at: run.createdAt, turn: null, run })),
  ].sort((a, b) => a.at - b.at);
  const items: AgentThreadItem<Run>[] = [];
  let group: PersonalAgentChatTurn[] = [];
  const flush = (withPending: boolean) => {
    if (!group.length && !(withPending && pending)) return;
    const key = `chat:${group[0]?.id ?? `pending:${pending?.clientMessageId}`}`;
    items.push({ kind: "chat", key, messages: agentThreadMessages(group, withPending ? pending : null) });
    group = [];
  };
  for (const entry of entries) {
    if (entry.turn) { group.push(entry.turn); continue; }
    flush(false);
    if (entry.run) items.push({ kind: "run", key: `run:${entry.run.id}`, run: entry.run });
  }
  flush(true);
  return items;
}
