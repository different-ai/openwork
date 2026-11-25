import { isGeneratedSessionTitle } from "@/app/lib/session-title";

export const SESSION_TITLE_RECOVERY_DELAYS_MS = [1_000, 5_000, 25_000] as const;

export type SessionTitleRecoveryMessage = {
  role: string;
  synthetic: boolean;
  error: unknown;
};

export type SessionTitleRecoveryRead = {
  title: string | null | undefined;
  messages: SessionTitleRecoveryMessage[];
};

type SessionTitleRecoveryOptions = {
  fetch: (sessionId: string) => Promise<SessionTitleRecoveryRead>;
  onResolved: (sessionId: string, title: string) => void;
  onFailure: (sessionId: string) => void;
  delaysMs?: readonly number[];
};

export type SessionTitleRecovery = {
  observe: (sessionId: string) => void;
  resolve: (sessionId: string) => void;
  dispose: () => void;
};

type PendingRecovery = {
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

type RecoveryReadState = "pending" | "failed" | "not-applicable" | "resolved";

export function classifySessionTitleRecoveryRead(read: SessionTitleRecoveryRead): RecoveryReadState {
  if (!isGeneratedSessionTitle(read.title)) return "resolved";

  const realUsers = read.messages.filter(
    (message) => message.role === "user" && !message.synthetic,
  );
  if (realUsers.length > 1) return "not-applicable";

  const latestUserIndex = read.messages.findLastIndex(
    (message) => message.role === "user" && !message.synthetic,
  );
  const successfulAssistant = read.messages
    .slice(latestUserIndex + 1)
    .some((message) => message.role === "assistant" && message.error == null);

  if (realUsers.length === 0 || !successfulAssistant) return "pending";
  return "failed";
}

export function createSessionTitleRecovery(options: SessionTitleRecoveryOptions): SessionTitleRecovery {
  const delaysMs = options.delaysMs ?? SESSION_TITLE_RECOVERY_DELAYS_MS;
  const pending = new Map<string, PendingRecovery>();
  const warned = new Set<string>();
  let disposed = false;

  const finish = (sessionId: string) => {
    const recovery = pending.get(sessionId);
    if (recovery?.timer) clearTimeout(recovery.timer);
    pending.delete(sessionId);
  };

  const schedule = (sessionId: string, recovery: PendingRecovery) => {
    const delayMs = delaysMs[recovery.attempt];
    if (delayMs === undefined) {
      finish(sessionId);
      return;
    }
    recovery.timer = setTimeout(() => {
      recovery.timer = null;
      void probe(sessionId, recovery);
    }, delayMs);
  };

  const probe = async (sessionId: string, recovery: PendingRecovery) => {
    if (disposed || pending.get(sessionId) !== recovery) return;

    let read: SessionTitleRecoveryRead;
    try {
      read = await options.fetch(sessionId);
    } catch {
      recovery.attempt += 1;
      schedule(sessionId, recovery);
      return;
    }
    if (disposed || pending.get(sessionId) !== recovery) return;

    const state = classifySessionTitleRecoveryRead(read);
    if (state === "resolved") {
      const title = read.title?.trim();
      if (title) options.onResolved(sessionId, title);
      finish(sessionId);
      return;
    }
    if (state === "not-applicable") {
      finish(sessionId);
      return;
    }

    const finalAttempt = recovery.attempt + 1 >= delaysMs.length;
    if (finalAttempt) {
      if (state === "failed" && !warned.has(sessionId)) {
        warned.add(sessionId);
        options.onFailure(sessionId);
      }
      finish(sessionId);
      return;
    }

    recovery.attempt += 1;
    schedule(sessionId, recovery);
  };

  return {
    observe: (sessionId) => {
      const id = sessionId.trim();
      if (!id || disposed || warned.has(id) || pending.has(id)) return;
      const recovery: PendingRecovery = { attempt: 0, timer: null };
      pending.set(id, recovery);
      schedule(id, recovery);
    },
    resolve: finish,
    dispose: () => {
      disposed = true;
      for (const recovery of pending.values()) {
        if (recovery.timer) clearTimeout(recovery.timer);
      }
      pending.clear();
    },
  };
}
