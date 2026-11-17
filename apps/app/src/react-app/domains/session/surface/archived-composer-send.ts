import type { DenSettings } from "@/app/lib/den-types";
import { holdSessionWork } from "@/app/lib/opencode-interruption";
import { t } from "@/i18n";
import { dispatchQueuedDrain } from "./queued-drain-machine";

type ArchivedComposerRestoreFailure = "unarchive_failed" | "verification_failed" | "timeout";

export class ArchivedComposerRestoreError extends Error {
  readonly code: ArchivedComposerRestoreFailure;

  constructor(code: ArchivedComposerRestoreFailure) {
    super(code);
    this.name = "ArchivedComposerRestoreError";
    this.code = code;
  }
}

export function archivedComposerRestoreErrorMessage(error: unknown): string {
  const code = error instanceof ArchivedComposerRestoreError ? error.code : "unarchive_failed";
  switch (code) {
    case "verification_failed": return t("session_management.archived_compose_verification_failed");
    case "timeout": return t("session_management.archived_compose_timeout");
    case "unarchive_failed": return t("session_management.archived_compose_unarchive_failed");
  }
}

export function isConfirmedUnarchivedSession(sessionId: string, session: {
  id: string;
  time: { archived?: number };
} | undefined): boolean {
  return session?.id === sessionId && !session.time.archived;
}

export type ArchivedSendIdentity = Pick<DenSettings, "authToken" | "baseUrl" | "activeOrgId">;

export function captureArchivedSendSelection(identity: ArchivedSendIdentity, agent: string | null) {
  return { identity: { authToken: identity.authToken, baseUrl: identity.baseUrl, activeOrgId: identity.activeOrgId }, agent };
}

export function sameArchivedSendIdentity(captured: ArchivedSendIdentity, current: ArchivedSendIdentity): boolean {
  return captured.authToken === current.authToken && captured.baseUrl === current.baseUrl
    && captured.activeOrgId === current.activeOrgId;
}

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
      let failure: ArchivedComposerRestoreFailure = "unarchive_failed";
      try {
        if (!await input.restore(controller.signal)) throw new ArchivedComposerRestoreError(failure);
        if (!current()) return false;
        failure = "verification_failed";
        if (!await input.verify(controller.signal)) throw new ArchivedComposerRestoreError(failure);
        return current();
      } catch {
        if (!current()) return false;
        throw new ArchivedComposerRestoreError(failure);
      }
    };
    confirmed = await Promise.race([restore(), cancelled]);
    if (timedOut) throw new ArchivedComposerRestoreError("timeout");
    return confirmed;
  } finally {
    clearTimeout(timeout);
    clearInterval(contextCheck);
    input.signal?.removeEventListener("abort", abort);
    removeAbortListener();
    controller.abort();
    if (!confirmed) dispatchQueuedDrain(input.lease.sessionId, { type: "send_error", itemId: input.lease.itemId });
    release();
  }
}
