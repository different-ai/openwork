import { readOrgSelectionPending } from "@/app/lib/den-sign-in-intent";
import { claimSignInReturnDraft, readSignInReturnTarget, type SignInReturnTarget } from "@/app/lib/den-sign-in-return";
import {
  clearSessionDraft,
  cloudSessionDraftScope,
  getSessionDraft,
  LOCAL_SESSION_DRAFT_SCOPE,
  NEW_TASK_DRAFT_SESSION_ID,
  saveSessionDraft,
  type SessionDraftIdentity,
} from "../session/sync/draft-store";

export function hasSignedOutDraft(target: Pick<SignInReturnTarget, "workspaceId" | "sessionId">) {
  return Boolean(target.workspaceId && getSessionDraft(LOCAL_SESSION_DRAFT_SCOPE, target.workspaceId,
    target.sessionId ?? NEW_TASK_DRAFT_SESSION_ID)?.text.trim());
}

/** Move only after consent; never overwrite a draft already in the account. */
function carrySignedOutDraft(target: Pick<SignInReturnTarget, "workspaceId" | "sessionId">, scope: string) {
  if (!target.workspaceId) return false;
  const slot = target.sessionId ?? NEW_TASK_DRAFT_SESSION_ID;
  const signedOut = getSessionDraft(LOCAL_SESSION_DRAFT_SCOPE, target.workspaceId, slot);
  if (!signedOut?.text.trim()) return false;
  if (getSessionDraft(scope, target.workspaceId, slot)?.text.trim()) return false;
  const saved = saveSessionDraft(scope, target.workspaceId, slot, { text: signedOut.text, mode: signedOut.mode });
  if (saved.status !== "saved") return false;
  clearSessionDraft(LOCAL_SESSION_DRAFT_SCOPE, target.workspaceId, slot);
  return true;
}

/**
 * A signed-out draft has no verifiable owner. Sign-in alone must never give it
 * to an account. The composer asks explicitly, naming the destination; bind
 * that choice to both the account scope and attempt shown when it was made.
 */
export function carrySignInReturnDraft(identity: SessionDraftIdentity, confirmation?: { scope: string; startedAt: number }): boolean {
  const target = readSignInReturnTarget();
  if (!target || target.signedInAt === null || target.draftCarried) return false;
  if (readOrgSelectionPending().pending) return false;
  const scope = cloudSessionDraftScope(identity);
  if (!scope || confirmation?.scope !== scope || confirmation.startedAt !== target.startedAt) return false;
  const claimed = claimSignInReturnDraft();
  return claimed ? carrySignedOutDraft(claimed, scope) : false;
}
