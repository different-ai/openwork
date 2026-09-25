import type { UIMessage } from "ai";
import type { ComposerDraft } from "@/app/types";
import type { AutoAccessWall } from "@/app/lib/inference-access";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import { toast } from "@/components/ui/sonner";
import { getComposerSessionDraftScope, releaseComposerSessionDraftScope, useComposerStateStore } from "../surface/composer-state-store";
import { clearQueuedSendContext, getQueuedSendContext } from "./queued-send-context";
import { composerAutoSendScopeKey } from "../surface/composer-auto-send";
import { composerAttachmentsToWorkspaceFileParts } from "./attachment-file-part";
import { getRejectedTurns, rejectedTurnOwnerKey, rejectedTurnOwnerSchema, saveRejectedTurn, sessionDraftScopeKey, type RejectedTurn, type RejectedTurnOwner } from "./draft-store";

export function suspendRejectedQueueForSignIn(owner: RejectedTurnOwner) {
  const context = getQueuedSendContext(owner.sessionId);
  const scopeKey = sessionDraftScopeKey(owner.scopeId, owner.workspaceId, owner.sessionId);
  if (owner.scopeId !== "local" || getComposerSessionDraftScope(owner.sessionId) !== scopeKey
    || !context?.rejectedOwner || rejectedTurnOwnerKey(context.rejectedOwner) !== rejectedTurnOwnerKey(owner)) return;
  releaseComposerSessionDraftScope(owner.sessionId, scopeKey);
  clearQueuedSendContext(owner.sessionId);
  useComposerStateStore.getState().clearQueuedDrafts(owner.sessionId);
}

export function rejectedRecoveryFromMessage(message: UIMessage) {
  const metadata = message.metadata;
  const parsed = rejectedTurnOwnerSchema.safeParse(metadata && typeof metadata === "object" ? Reflect.get(metadata, "rejectedOwner") : null);
  return parsed.success && getRejectedTurns(parsed.data).some((turn) => turn.id === message.id)
    ? { owner: parsed.data, id: message.id } : undefined;
}

export function rejectedTurnFromDraft(draft: ComposerDraft & { messageId: string }, wall: AutoAccessWall, afterMessageId: string | null, created = Date.now()): RejectedTurn {
  return { id: draft.messageId, text: draft.resolvedText ?? draft.text, created, afterMessageId, wall,
    attachments: draft.attachments.map((file) => ({ name: file.name, mime: file.mimeType })) };
}

export async function retainRejectedTurn(input: {
  owner: RejectedTurnOwner; opencodeBaseUrl: string; draft: ComposerDraft & { messageId: string };
  wall: AutoAccessWall; afterMessageId?: string | null; remainingQueued?: string[]; queuedItemId?: string;
  client: OpenworkServerClient; workspaceRoot: string; localRuntime: boolean;
}) {
  const { owner, draft, wall } = input;
  const turn = rejectedTurnFromDraft(draft, wall, input.afterMessageId ?? null);
  const memoryOwner = composerAutoSendScopeKey({ draftScope: owner.scopeId, opencodeBaseUrl: input.opencodeBaseUrl, workspaceId: owner.workspaceId, sessionId: owner.sessionId });
  useComposerStateStore.setState((state) => {
    const previous = state.pendingMessages[memoryOwner] ?? [];
    const existing = previous.find((item) => item.draft.messageId === draft.messageId);
    const item = existing ? { ...existing, settled: true, autoAccessWall: wall } : {
      draft, composer: { draft: draft.text, attachments: draft.attachments, mentions: {}, pasteParts: [], revertMessageId: null },
      previousMessageIds: [], submissionMessageIds: turn.afterMessageId ? [turn.afterMessageId] : [], settled: true, autoAccessWall: wall,
    };
    return { pendingMessages: { ...state.pendingMessages, [memoryOwner]: existing
      ? previous.map((entry) => entry === existing ? item : entry) : [...previous, item] } };
  });
  const saved = saveRejectedTurn(owner, turn, input.remainingQueued ? { remaining: input.remainingQueued } : undefined) === "saved";
  if (!saved) {
    toast.error("Your unsent message could not be saved. Keep this chat open or copy it before closing.");
    return false;
  }
  if (input.queuedItemId) useComposerStateStore.getState().removeQueuedDraft(owner.sessionId, input.queuedItemId);
  if (draft.attachments.length && input.localRuntime) {
    try {
      const uploaded = await composerAttachmentsToWorkspaceFileParts({ attachments: draft.attachments,
        endpoint: { client: input.client, workspaceId: owner.workspaceId }, sessionId: owner.sessionId, workspaceRoot: input.workspaceRoot, preserveWorkspaceFiles: true });
      if (uploaded) {
        const attachments = (uploaded.workspaceFiles ?? []).map((file) => ({ name: file.filename, mime: file.mime, url: file.url }));
        if (saveRejectedTurn(owner, { ...turn, attachments }) !== "saved") throw new Error("Attachment references could not be saved");
      }
    } catch {
      toast.error("Your unsent message is saved, but its files could not be kept. Reattach them before sending again.");
    }
  }
  return true;
}

export function mergeRejectedTurns(messages: readonly UIMessage[], turns: readonly RejectedTurn[], owner: RejectedTurnOwner): UIMessage[] {
  const result = [...messages];
  for (const turn of [...turns].sort((left, right) => left.created - right.created)) {
    const index = result.findIndex((message) => message.id === turn.id);
    const metadata = { autoAccessWall: turn.wall, unprocessed: true, rejectedOwner: owner, opencode: { created: turn.created } };
    if (index !== -1) {
      if (result[index].role === "user" && result[index].metadata && typeof result[index].metadata === "object"
        && Reflect.get(result[index].metadata, "unprocessed") === true) result[index] = { ...result[index], metadata };
      continue;
    }
    const parts: UIMessage["parts"] = [{ type: "text", text: turn.text }];
    for (const file of turn.attachments) {
      if (file.url) parts.push({ type: "file", url: file.url, filename: file.name, mediaType: file.mime });
      else parts.push({ type: "text", text: `\nAttachment: ${file.name} — reattach before sending again.` });
    }
    const anchor = turn.afterMessageId ? result.findIndex((message) => message.id === turn.afterMessageId) : -1;
    let insertion = anchor === -1 ? result.length : anchor + 1;
    while (insertion < result.length && turns.some((candidate) => candidate.id === result[insertion].id)) insertion++;
    result.splice(insertion, 0, { id: turn.id, role: "user", metadata, parts });
  }
  return result;
}
