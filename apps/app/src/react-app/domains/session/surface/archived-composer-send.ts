import type { DenSettings } from "@/app/lib/den-types";
import { holdSessionWork } from "@/app/lib/opencode-interruption";
import { dispatchQueuedDrain } from "./queued-drain-machine";

export function isConfirmedUnarchivedSession(sessionId: string, session: {
  id: string;
  time: { archived?: number };
} | undefined): boolean {
  return session?.id === sessionId && !session.time.archived;
}

export type ArchivedSendIdentity = Pick<DenSettings, "authToken" | "baseUrl" | "activeOrgId">;

/** Freeze both selections at the human action, before any restore/readiness wait. */
export function captureArchivedSendSelection(identity: ArchivedSendIdentity, agent: string | null) {
  return { identity: { authToken: identity.authToken, baseUrl: identity.baseUrl, activeOrgId: identity.activeOrgId }, agent };
}

/** Capture before Restore; never adopt a different member or organization during the wait. */
export function sameArchivedSendIdentity(captured: ArchivedSendIdentity, current: ArchivedSendIdentity): boolean {
  return captured.authToken === current.authToken && captured.baseUrl === current.baseUrl
    && captured.activeOrgId === current.activeOrgId;
}

/**
 * Own the restore-only lease, even when a transport ignores abort. Late work
 * can reconcile archive metadata, but has no continuation that can send.
 */
export async function confirmArchivedComposerRestore(input: {
  lease: { baseUrl: string; sessionId: string; itemId: string };
  restore: (signal: AbortSignal) => Promise<boolean>;
  verify: (signal: AbortSignal) => Promise<boolean>;
  isCurrent: () => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<boolean> {
  const release = holdSessionWork(input.lease.baseUrl, input.lease.sessionId);
  const controller = new AbortController();
  let confirmed = false;
  let timedOut = false;
  const abort = () => controller.abort();
  const timeout = setTimeout(() => { timedOut = true; abort(); }, input.timeoutMs ?? 15_000);
  // Stop/generation and Den identity can change without a React render.
  const contextCheck = setInterval(() => { if (!input.isCurrent()) abort(); }, 50);
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted || !input.isCurrent()) abort();
  let removeAbortListener = () => {};
  const cancelled = new Promise<false>((resolve) => {
    const onAbort = () => resolve(false);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
    if (controller.signal.aborted) resolve(false);
  });
  const current = () => !controller.signal.aborted && input.isCurrent();
  try {
    if (!current()) return false;
    const restore = async () => {
      if (!await input.restore(controller.signal)) {
        throw new Error("Couldn't unarchive this conversation. Your draft is saved. Try Send & unarchive again.");
      }
      if (!current()) return false;
      if (!await input.verify(controller.signal)) {
        throw new Error("Couldn't verify that this conversation was unarchived. Your draft is saved. Try sending again.");
      }
      return current();
    };
    confirmed = await Promise.race([restore(), cancelled]);
    if (timedOut) throw new Error("Unarchiving timed out. Your draft is saved. Try sending again.");
    return confirmed;
  } finally {
    clearTimeout(timeout);
    clearInterval(contextCheck);
    input.signal?.removeEventListener("abort", abort);
    removeAbortListener();
    controller.abort();
    // The reducer matches itemId, so a late cleanup cannot release a newer send.
    if (!confirmed) dispatchQueuedDrain(input.lease.sessionId, { type: "send_error", itemId: input.lease.itemId });
    release();
  }
}
