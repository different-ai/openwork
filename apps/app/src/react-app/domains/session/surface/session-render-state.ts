import type { UIMessage } from "ai";

import type { OpenworkSessionSnapshot } from "../../../../app/lib/openwork-server";
import { mergeSnapshotAndLiveMessages } from "../sync/message-merge";
import { applyRevertCursor } from "../sync/transcript-reconcile";
import { snapshotToUIMessages } from "../sync/usechat-adapter";
import { parseConnectSkillToken } from "./composer/connect-skill-token";
import { parseSlashCommandInvocation } from "./composer/slash-command";

export function resolveRenderedSessionSnapshot(input: {
  sessionId: string;
  currentSnapshot: OpenworkSessionSnapshot | null | undefined;
  cachedRendered: { sessionId: string; snapshot: OpenworkSessionSnapshot } | null | undefined;
}) {
  if (input.currentSnapshot?.session.id === input.sessionId) {
    return input.currentSnapshot;
  }
  if (
    input.cachedRendered?.sessionId === input.sessionId &&
    input.cachedRendered.snapshot.session.id === input.sessionId
  ) {
    return input.cachedRendered.snapshot;
  }
  return null;
}

export function deriveRenderedSessionMessages(input: {
  transcriptState: UIMessage[] | null | undefined;
  snapshot: OpenworkSessionSnapshot | null | undefined;
}) {
  const revertMessageId = input.snapshot?.session.revert?.messageID ?? null;
  const liveMessages = input.transcriptState ?? [];

  const snapshotMessages = input.snapshot && input.snapshot.messages.length > 0
    ? snapshotToUIMessages(input.snapshot)
    : [];

  // Render the server snapshot as the history floor and layer live stream
  // updates on top. During prompt submission the live cache can briefly contain
  // only the new turn; it must not replace the older persisted transcript.
  const messages = snapshotMessages.length > 0
    ? mergeSnapshotAndLiveMessages(snapshotMessages, liveMessages, { appendLiveOnlyMessages: true })
    : liveMessages;

  return applyRevertCursor(messages, revertMessageId);
}

export function deriveComposerHistory(messages: readonly UIMessage[]): string[] {
  const history: string[] = [];
  // Use the reconciled transcript: native projections already exclude synthetic
  // and ignored text, and message identity reconciles snapshots with live sends.
  for (const message of messages) {
    if (message.role !== "user") continue;
    let unsafe = false;
    const text = message.parts.flatMap((part) => {
      if (part.type !== "text") return [];
      const metadata = part.providerMetadata?.opencode;
      const token = metadata && typeof metadata === "object" && "composerToken" in metadata
        ? metadata.composerToken : undefined;
      if (typeof token === "string") {
        const skill = parseConnectSkillToken(token);
        if (skill && part.text === `/${skill.slug}`) return [token];
        unsafe = true;
      }
      // Older labels have no durable skill identity. Never recall them as commands
      // or try to recover that identity from generated model instructions.
      if (parseSlashCommandInvocation(part.text.replace(/\s+/g, " "))) unsafe = true;
      return [part.text];
    }).join("\n").trim();
    if (unsafe) continue;
    if (text && history.at(-1) !== text) history.push(text);
  }
  return history.slice(-50);
}
