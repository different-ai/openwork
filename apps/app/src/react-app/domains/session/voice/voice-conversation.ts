import type { ComposerDraft } from "@/app/types";
import { createClient } from "@/app/lib/opencode";
import { abortSessionSafe } from "@/app/lib/opencode-session";
import { composeNativeSessionSnapshot } from "@/app/lib/opencode-session-native";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import type { CloudMcpSubmissionResult } from "../../connections/cloud-mcp-submit-readiness";
import { getComposerQueuedDrafts, useComposerStateStore } from "../surface/composer-state-store";
import { dispatchQueuedDrain } from "../surface/queued-drain-machine";

export type VoiceConversation = {
  sessionId: string;
  workspaceId: string;
  workspaceRoot: string;
  opencodeBaseUrl: string;
  token: string;
  client: OpenworkServerClient;
  isCurrent: () => boolean;
  needsScreen: () => boolean;
  submit: (draft: ComposerDraft, sessionId: string) => Promise<CloudMcpSubmissionResult>;
};
export function readVoiceConversation(owner: VoiceConversation, signal: AbortSignal) {
  return composeNativeSessionSnapshot({ opencodeBaseUrl: owner.opencodeBaseUrl, token: owner.token }, owner.sessionId, { limit: 40, signal });
}
/** Same directory-scoped abort and queue semantics as the conversation's Stop control. */
export async function cancelVoiceConversation(owner: VoiceConversation) {
  if (!owner.isCurrent()) return false;
  const composer = useComposerStateStore.getState();
  for (const item of getComposerQueuedDrafts(composer, owner.sessionId)) {
    for (const attachment of item.draft.attachments) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
  }
  composer.clearQueuedDrafts(owner.sessionId);
  dispatchQueuedDrain(owner.sessionId, { type: "queue_cleared" });
  const client = createClient(owner.opencodeBaseUrl, undefined, { mode: "openwork", token: owner.token });
  return abortSessionSafe(client, owner.sessionId, owner.workspaceRoot.trim() || undefined, {
    source: "voice.cancel_operation", initiator: "user", reason: "user requested cancellation in this conversation",
  });
}
