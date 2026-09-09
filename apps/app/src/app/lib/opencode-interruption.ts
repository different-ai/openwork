import type { Client } from "../types";
import { isPromptAdmissionUnknown, unwrap } from "./opencode";

type Submission = {
  messageID?: string;
  settled: boolean;
  error?: unknown;
  cancel: () => void;
};
type Turn = {
  generation: number;
  submissions: Set<Submission>;
  interruption?: Promise<void>;
  stopping: boolean;
  needsStop: boolean;
  listeners: Set<() => void>;
};
const turns = new Map<string, Turn>();

function turnFor(baseUrl: string, sessionID: string) {
  const key = JSON.stringify([baseUrl.replace(/\/+$/, ""), sessionID]);
  let turn = turns.get(key);
  if (!turn) {
    turn = { generation: 0, submissions: new Set(), stopping: false, needsStop: false, listeners: new Set() };
    turns.set(key, turn);
  }
  return turn;
}

/** Shared by visible panes and the background queue. A successor cannot enter
 * the engine while Stop is still cancelling its predecessor's children. */
export async function submitAfterInterruption<T>(baseUrl: string, sessionID: string, send: (afterStop: boolean) => Promise<T>, messageID?: string): Promise<T> {
  const turn = turnFor(baseUrl, sessionID);
  const generation = turn.generation;
  const interruption = turn.interruption;
  await interruption;
  if (turn.generation !== generation) throw new Error("Send cancelled by Stop.");
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error("Send cancelled by Stop."));
  });
  const submission: Submission = {
    messageID, settled: false, cancel,
  };
  const pending = send(interruption !== undefined).then(
    (result) => { submission.settled = true; return result; },
    (error: unknown) => { submission.settled = true; submission.error = error; throw error; },
  );
  turn.submissions.add(submission);
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    turn.submissions.delete(submission);
  }
}

export function sessionNeedsStop(baseUrl: string, sessionID: string): boolean {
  return turnFor(baseUrl, sessionID).needsStop;
}

export function sessionIsStopping(baseUrl: string, sessionID: string): boolean {
  return turnFor(baseUrl, sessionID).stopping;
}

export function subscribeSessionInterruption(baseUrl: string, sessionID: string, listener: () => void): () => void {
  const turn = turnFor(baseUrl, sessionID);
  turn.listeners.add(listener);
  return () => { turn.listeners.delete(listener); };
}

/** Keep a failed interruption fenced until the user retries Stop. Forgetting
 * it on failure would silently steer the next message into the old run. */
export function interruptSessionTurn(
  baseUrl: string,
  client: Client,
  sessionID: string,
  directory?: string,
  options: { timeoutMs?: number; admissionUnknown?: boolean; onStopped?: () => void } = {},
): Promise<void> {
  const turn = turnFor(baseUrl, sessionID);
  // Share the cancellation request, not permission for intervening sends to
  // survive another explicit Stop.
  turn.generation += 1;
  if (turn.stopping && turn.interruption) return turn.interruption;
  turn.stopping = true;
  turn.needsStop = true;
  const pending = [...turn.submissions];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Stopping the previous turn timed out. Retry Stop before sending.")), options.timeoutMs ?? 15_000);
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  const interruption = Promise.race([
    stopForegroundTree(client, sessionID, directory, pending, controller.signal, options.admissionUnknown === true),
    deadline,
  ]).then(() => {
    // Reconcile the old admission before releasing waiting successor sends.
    options.onStopped?.();
    turn.interruption = undefined;
    turn.needsStop = false;
  }).finally(() => {
    clearTimeout(timer);
    controller.abort(new Error("Stop operation finished."));
    turn.stopping = false;
    for (const listener of turn.listeners) listener();
  });
  turn.interruption = interruption;
  for (const listener of turn.listeners) listener();
  // Retain rejection for future submissions without an unhandled rejection.
  void interruption.catch(() => {});
  return interruption;
}

async function stopForegroundTree(
  client: Client,
  rootID: string,
  directory: string | undefined,
  pending: readonly Submission[],
  signal: AbortSignal,
  admissionUnknown: boolean,
) {
  const options = { signal };
  const children = async (sessionID: string) => {
    signal.throwIfAborted();
    const messages = unwrap(await client.session.messages({ sessionID, directory }, options));
    const turnStart = messages.findLastIndex(({ info }) => info.role === "user");
    return messages.slice(Math.max(0, turnStart)).flatMap(({ parts }) => parts.flatMap((part) => {
      if (part.type !== "tool" || !["task", "subagent"].includes(part.tool)
        || part.state.status === "completed" || part.state.input.background === true) return [];
      const metadata = "metadata" in part.state ? part.state.metadata : undefined;
      if (metadata?.background === true) return [];
      const id = metadata?.sessionId ?? metadata?.sessionID;
      return typeof id === "string" && id !== sessionID ? [id] : [];
    }));
  };
  const abort = async (sessionID: string) => {
    signal.throwIfAborted();
    // A false acknowledgement may mean the native cascade already stopped a
    // child. Only the final authoritative idle check establishes settlement.
    unwrap(await client.session.abort({ sessionID, directory }, options));
  };
  // Stop must reach the engine even when session/transcript reads are broken.
  // Read concurrently to retain child references, but never gate the root abort
  // on discovery. Failed discovery still prevents claiming a complete handoff.
  const [aborted, rootResult, childResult] = await Promise.allSettled([
    abort(rootID),
    client.session.get({ sessionID: rootID, directory }, options).then(unwrap),
    children(rootID),
  ]);
  // Do not let a fast discovery failure cancel an abort still in flight.
  if (aborted.status === "rejected") throw aborted.reason;
  if (rootResult.status === "rejected") throw rootResult.reason;
  if (childResult.status === "rejected") throw childResult.reason;
  const root = rootResult.value;
  const before = childResult.value;
  if (root.id !== rootID) {
    throw new Error("Could not verify the conversation's workspace. Stop was not confirmed.");
  }
  if (directory !== undefined && root.directory !== directory) {
    // The engine may canonicalize a scoped directory (for example, a symlinked
    // OS path). Trust the engine's scoped /path result, not a browser-side path
    // rewrite or the session's claim alone.
    const canonical = unwrap(await client.path.get({ directory }, options));
    if (typeof canonical.directory !== "string" || canonical.directory.length === 0 || canonical.directory !== root.directory) {
      throw new Error("Could not verify the conversation's workspace. Stop was not confirmed.");
    }
  }
  const targets = new Set<string>();
  const stop = async (sessionID: string, knownChildren: string[] = []) => {
    signal.throwIfAborted();
    if (targets.has(sessionID)) return;
    if (targets.size >= 256) throw new Error("Too many delegated sessions to confirm Stop.");
    targets.add(sessionID);
    const before = await children(sessionID);
    await abort(sessionID);
    // Cancellation can race task metadata publication. Read again after the
    // parent stops; include cancelled tool parts, but never completed or
    // explicitly background tasks, nor descendants from an older user turn.
    const ids = new Set([...knownChildren, ...before, ...await children(sessionID)]);
    for (const id of ids) {
      signal.throwIfAborted();
      const child = unwrap(await client.session.get({ sessionID: id, directory }, options));
      if (child.parentID !== sessionID || child.directory !== root.directory) {
        throw new Error("Could not verify the delegated session owner. Stop was not confirmed.");
      }
      await stop(id);
    }
  };
  const waiting = new Set(pending);
  const reconciled = new Set<Submission>();
  while (waiting.size > 0) {
    signal.throwIfAborted();
    for (const submission of waiting) if (submission.settled) waiting.delete(submission);
    if (waiting.size === 0) break;
    if ([...waiting].some((submission) => submission.messageID !== undefined)) {
      const messages = unwrap(await client.session.messages({ sessionID: rootID, directory }, options));
      const statuses = unwrap(await client.session.status({ directory }, options));
      signal.throwIfAborted();
      if (!statuses[rootID] || statuses[rootID].type === "idle") {
        for (const submission of waiting) {
          const id = submission.messageID;
          if (id === undefined) continue;
          const admitted = messages.some(({ info }) => info.id === id && info.sessionID === rootID && info.role === "user");
          const terminal = messages.some(({ info, parts }) => info.role === "assistant" && info.sessionID === rootID
            && info.parentID === id && typeof info.time.completed === "number" && info.finish !== "tool-calls"
            && !parts.some((part) => part.type === "tool" && ["pending", "running"].includes(part.state.status)));
          // Exact terminal evidence reconciles a lost response, not an absent
          // message or an idle snapshot on its own. Reject only the UI wait;
          // never replay the request, and still stop/verify the child tree below.
          if (admitted && terminal) {
            reconciled.add(submission);
            submission.cancel();
            waiting.delete(submission);
          }
        }
      }
    }
    if (waiting.size > 0) await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  signal.throwIfAborted();
  await stop(rootID, before);
  // A lost admission response is not proof that the old POST cannot arrive
  // later. Do not claim a clean handoff or replay that prompt.
  if (admissionUnknown || pending.some((submission) => !reconciled.has(submission) && isPromptAdmissionUnknown(submission.error))) {
    throw new Error("The previous message's acceptance is still unknown. Check acceptance, then retry Stop.");
  }
  while (true) {
    signal.throwIfAborted();
    const statuses = unwrap(await client.session.status({ directory }, options));
    if ([...targets].every((id) => !statuses[id] || statuses[id].type === "idle")) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}
