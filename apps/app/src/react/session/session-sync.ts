import type { UIMessage } from "ai";
import type { Part, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client";

import { getReactQueryClient } from "../kernel/query-client";
import { createClient } from "../../app/lib/opencode";
import { normalizeEvent } from "../../app/utils";
import type { OpencodeEvent } from "../../app/types";
import { snapshotToUIMessages } from "./usechat-adapter";
import type { OpenworkSessionSnapshot } from "../../app/lib/openwork-server";

type SyncOptions = {
  workspaceId: string;
  baseUrl: string;
  openworkToken: string;
};

type SyncEntry = {
  refs: number;
  stopTimer: ReturnType<typeof setTimeout> | null;
  dispose: () => void;
  pendingDeltas: Map<string, { messageId: string; reasoning: boolean; text: string }>;
};

const idleStatus: SessionStatus = { type: "idle" };
const syncs = new Map<string, SyncEntry>();

export const transcriptKey = (workspaceId: string, sessionId: string) =>
  ["react-session-transcript", workspaceId, sessionId] as const;
export const statusKey = (workspaceId: string, sessionId: string) =>
  ["react-session-status", workspaceId, sessionId] as const;
export const todoKey = (workspaceId: string, sessionId: string) =>
  ["react-session-todos", workspaceId, sessionId] as const;

function syncKey(input: SyncOptions) {
  return `${input.workspaceId}:${input.baseUrl}:${input.openworkToken}`;
}

function toUIPart(part: Part): UIMessage["parts"][number] | null {
  if (part.type === "text") {
    return {
      type: "text",
      text: typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "",
      state: "done",
      providerMetadata: { opencode: { partId: part.id } },
    };
  }
  if (part.type === "reasoning") {
    return {
      type: "reasoning",
      text: typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "",
      state: "done",
      providerMetadata: { opencode: { partId: part.id } },
    };
  }
  if (part.type === "file") {
    const file = part as Part & { url?: string; filename?: string; mime?: string };
    if (!file.url) return null;
    return {
      type: "file",
      url: file.url,
      filename: file.filename,
      mediaType: file.mime ?? "application/octet-stream",
      providerMetadata: { opencode: { partId: part.id } },
    };
  }
  if (part.type === "tool") {
    const record = part as Part & { tool?: string; state?: Record<string, unknown> };
    const state = record.state ?? {};
    const toolName = typeof record.tool === "string" ? record.tool : "tool";
    if (typeof state.error === "string" && state.error.trim()) {
      return {
        type: "dynamic-tool",
        toolName,
        toolCallId: part.id,
        state: "output-error",
        input: state.input,
        errorText: state.error,
      };
    }
    if (state.output !== undefined) {
      return {
        type: "dynamic-tool",
        toolName,
        toolCallId: part.id,
        state: "output-available",
        input: state.input,
        output: state.output,
      };
    }
    return {
      type: "dynamic-tool",
      toolName,
      toolCallId: part.id,
      state: "input-available",
      input: state.input,
    };
  }
  if (part.type === "step-start") return { type: "step-start" };
  return null;
}

function getPartMetadataId(part: UIMessage["parts"][number]) {
  if (part.type !== "text" && part.type !== "reasoning" && part.type !== "file") return null;
  const metadata = part.providerMetadata?.opencode;
  if (!metadata || typeof metadata !== "object") return null;
  return "partId" in metadata ? (metadata as { partId?: string }).partId ?? null : null;
}

function upsertMessage(messages: UIMessage[], next: UIMessage) {
  const index = messages.findIndex((message) => message.id === next.id);
  if (index === -1) return [...messages, next];
  return messages.map((message, messageIndex) =>
    messageIndex === index
      ? {
          ...message,
          ...next,
          parts: next.parts.length > 0 ? next.parts : message.parts,
        }
      : message,
  );
}

function upsertPart(messages: UIMessage[], messageId: string, partId: string, next: UIMessage["parts"][number]) {
  return messages.map((message) => {
    if (message.id !== messageId) return message;
    const index = message.parts.findIndex((part) =>
      ("toolCallId" in part && part.toolCallId === partId) || getPartMetadataId(part) === partId,
    );
    if (index === -1) {
      return { ...message, parts: [...message.parts, next] };
    }
    const parts = message.parts.slice();
    parts[index] = next;
    return { ...message, parts };
  });
}

function appendDelta(messages: UIMessage[], messageId: string, partId: string, delta: string, reasoning: boolean) {
  return messages.map((message) => {
    if (message.id !== messageId) return message;

    // Try to find and update an existing matching part
    let matched = false;
    const parts = message.parts.map((part) => {
      if (reasoning && part.type === "reasoning") {
        const id = getPartMetadataId(part);
        if (id === partId || (!id && message.parts.at(-1) === part)) {
          matched = true;
          return { ...part, text: `${part.text}${delta}`, state: "streaming" as const };
        }
      }
      if (!reasoning && part.type === "text") {
        const id = getPartMetadataId(part);
        if (id === partId || (!id && message.parts.at(-1) === part)) {
          matched = true;
          return { ...part, text: `${part.text}${delta}`, state: "streaming" as const };
        }
      }
      if (part.type === "dynamic-tool" && part.toolCallId === partId) return part;
      return part;
    });

    // If no existing part matched, create a new one so the delta is not lost
    if (!matched) {
      const newPart: UIMessage["parts"][number] = reasoning
        ? { type: "reasoning", text: delta, state: "streaming" as const, providerMetadata: { opencode: { partId } } }
        : { type: "text", text: delta, state: "streaming" as const, providerMetadata: { opencode: { partId } } };
      return { ...message, parts: [...parts, newPart] };
    }

    return { ...message, parts };
  });
}

function applyEvent(entry: SyncEntry, workspaceId: string, event: OpencodeEvent) {
  const queryClient = getReactQueryClient();

  if (event.type === "session.status") {
    const props = (event.properties ?? {}) as { sessionID?: string; status?: SessionStatus };
    if (!props.sessionID || !props.status) return;
    queryClient.setQueryData(statusKey(workspaceId, props.sessionID), props.status);
    return;
  }

  if (event.type === "todo.updated") {
    const props = (event.properties ?? {}) as { sessionID?: string; todos?: Todo[] };
    if (!props.sessionID || !props.todos) return;
    queryClient.setQueryData(todoKey(workspaceId, props.sessionID), props.todos);
    return;
  }

  if (event.type === "message.updated") {
    const props = (event.properties ?? {}) as { info?: { id?: string; role?: UIMessage["role"] | string; sessionID?: string } };
    const info = props.info;
    if (!info?.id || !info.sessionID || (info.role !== "user" && info.role !== "assistant" && info.role !== "system")) {
      return;
    }
    const next = { id: info.id, role: info.role, parts: [] } satisfies UIMessage;
    queryClient.setQueryData<UIMessage[]>(transcriptKey(workspaceId, info.sessionID), (current = []) =>
      upsertMessage(current, next),
    );
    return;
  }

  if (event.type === "message.part.updated") {
    const props = (event.properties ?? {}) as { part?: Part };
    const part = props.part;
    if (!part?.sessionID || !part.messageID) return;
    const mapped = toUIPart(part);
    if (!mapped) return;
    const pending = entry.pendingDeltas.get(part.id);
    const seededPart =
      pending && ((mapped.type === "text" && !pending.reasoning) || (mapped.type === "reasoning" && pending.reasoning))
        ? { ...mapped, text: `${mapped.text}${pending.text}`, state: "streaming" as const }
        : mapped;
    queryClient.setQueryData<UIMessage[]>(transcriptKey(workspaceId, part.sessionID), (current = []) => {
      const withMessage = upsertMessage(current, { id: part.messageID, role: "assistant", parts: [] });
      return upsertPart(withMessage, part.messageID, part.id, seededPart);
    });
    if (pending) entry.pendingDeltas.delete(part.id);
    return;
  }

  if (event.type === "message.part.delta") {
    const props = (event.properties ?? {}) as {
      sessionID?: string;
      messageID?: string;
      partID?: string;
      field?: string;
      delta?: string;
    };
    if (!props.sessionID || !props.messageID || !props.partID || !props.delta) return;
    queryClient.setQueryData<UIMessage[]>(transcriptKey(workspaceId, props.sessionID), (current = []) => {
      // Ensure the message shell exists before appending the delta
      const withMessage = upsertMessage(current, { id: props.messageID!, role: "assistant", parts: [] });
      const next = appendDelta(withMessage, props.messageID!, props.partID!, props.delta!, props.field === "reasoning");
      const message = next.find((item) => item.id === props.messageID);
      const matched = message?.parts.some((part) =>
        (part.type === "dynamic-tool" && part.toolCallId === props.partID) || getPartMetadataId(part) === props.partID,
      );
      if (!matched) {
        const pending = entry.pendingDeltas.get(props.partID!) ?? {
          messageId: props.messageID!,
          reasoning: props.field === "reasoning",
          text: "",
        };
        pending.text += props.delta!;
        entry.pendingDeltas.set(props.partID!, pending);
      }
      return next;
    });
    return;
  }

  if (event.type === "session.idle") {
    const props = (event.properties ?? {}) as { sessionID?: string };
    if (!props.sessionID) return;
    queryClient.setQueryData(statusKey(workspaceId, props.sessionID), idleStatus);
  }
}

function startSync(input: SyncOptions) {
  const client = createClient(input.baseUrl, undefined, { token: input.openworkToken, mode: "openwork" });
  const controller = new AbortController();
  const entry = syncs.get(syncKey(input));

  void client.event.subscribe(undefined, { signal: controller.signal }).then((sub) => {
    void (async () => {
      for await (const raw of sub.stream) {
        if (controller.signal.aborted) return;
        const event = normalizeEvent(raw);
        if (!event) continue;
        if (!entry) continue;
        applyEvent(entry, input.workspaceId, event);
      }
    })();
  });

  return () => controller.abort();
}

export function ensureWorkspaceSessionSync(input: SyncOptions) {
  const key = syncKey(input);
  const existing = syncs.get(key);
  if (existing) {
    existing.refs += 1;
    if (existing.stopTimer) {
      clearTimeout(existing.stopTimer);
      existing.stopTimer = null;
    }
    return () => releaseWorkspaceSessionSync(input);
  }

  syncs.set(key, {
    refs: 1,
    stopTimer: null,
    dispose: () => {},
    pendingDeltas: new Map(),
  });

  const created = syncs.get(key)!;
  created.dispose = startSync(input);

  return () => releaseWorkspaceSessionSync(input);
}

function releaseWorkspaceSessionSync(input: SyncOptions) {
  const key = syncKey(input);
  const existing = syncs.get(key);
  if (!existing) return;
  existing.refs -= 1;
  if (existing.refs > 0) return;
  existing.stopTimer = setTimeout(() => {
    existing.dispose();
    syncs.delete(key);
  }, 10_000);
}

export function seedSessionState(workspaceId: string, snapshot: OpenworkSessionSnapshot) {
  const queryClient = getReactQueryClient();
  const key = transcriptKey(workspaceId, snapshot.session.id);
  const incoming = snapshotToUIMessages(snapshot);
  const existing = queryClient.getQueryData<UIMessage[]>(key);

  if (existing && existing.length > 0 && (snapshot.status.type === "busy" || snapshot.status.type === "retry")) {
    // During active streaming the server snapshot may have empty/stale text
    // for in-progress parts while the cache already accumulated text via
    // deltas.  Merge so we never overwrite longer cached text with shorter
    // server text.
    const merged = incoming.map((incomingMsg) => {
      const cachedMsg = existing.find((m) => m.id === incomingMsg.id);
      if (!cachedMsg) return incomingMsg;
      const parts = incomingMsg.parts.map((inPart, index) => {
        const cachedPart = cachedMsg.parts[index];
        if (!cachedPart) return inPart;
        if (
          (inPart.type === "text" || inPart.type === "reasoning") &&
          (cachedPart.type === "text" || cachedPart.type === "reasoning") &&
          cachedPart.text.length > inPart.text.length
        ) {
          return { ...inPart, text: cachedPart.text };
        }
        return inPart;
      });
      // Keep any extra cached parts the server doesn't know about yet
      if (cachedMsg.parts.length > incomingMsg.parts.length) {
        for (let i = incomingMsg.parts.length; i < cachedMsg.parts.length; i++) {
          parts.push(cachedMsg.parts[i]);
        }
      }
      return { ...incomingMsg, parts };
    });
    queryClient.setQueryData(key, merged);
  } else {
    queryClient.setQueryData(key, incoming);
  }

  queryClient.setQueryData(statusKey(workspaceId, snapshot.session.id), snapshot.status);
  queryClient.setQueryData(todoKey(workspaceId, snapshot.session.id), snapshot.todos);
}
