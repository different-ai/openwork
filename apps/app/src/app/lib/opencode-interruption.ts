import type { Client } from "../types";
import { isPromptAdmissionUnknown, unwrap } from "./opencode";

type Turn = {
  generation: number;
  submissions: Set<Promise<unknown>>;
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
export async function submitAfterInterruption<T>(baseUrl: string, sessionID: string, send: (afterStop: boolean) => Promise<T>): Promise<T> {
  const turn = turnFor(baseUrl, sessionID);
  const generation = turn.generation;
  const interruption = turn.interruption;
  await interruption;
  if (turn.generation !== generation) throw new Error("Send cancelled by Stop.");
  const pending = send(interruption !== undefined);
  turn.submissions.add(pending);
  try {
    return await pending;
  } finally {
    turn.submissions.delete(pending);
  }
}

export function sessionNeedsStop(baseUrl: string, sessionID: string): boolean {
  return turnFor(baseUrl, sessionID).needsStop;
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
  if (turn.stopping && turn.interruption) return turn.interruption;
  turn.generation += 1;
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
  pending: readonly Promise<unknown>[],
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
  const root = unwrap(await client.session.get({ sessionID: rootID, directory }, options));
  if (root.id !== rootID || (directory !== undefined && root.directory !== directory)) {
    throw new Error("Could not verify the conversation's workspace. Stop was not confirmed.");
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
  const before = await children(rootID);
  // Stop active work promptly, even if an older shell/send has not returned.
  await abort(rootID);
  const settled = await Promise.allSettled(pending);
  signal.throwIfAborted();
  await stop(rootID, before);
  // A lost admission response is not proof that the old POST cannot arrive
  // later. Do not claim a clean handoff or replay that prompt.
  if (admissionUnknown || settled.some((result) => result.status === "rejected" && isPromptAdmissionUnknown(result.reason))) {
    throw new Error("The previous message's acceptance is still unknown. Check acceptance, then retry Stop.");
  }
  while (true) {
    signal.throwIfAborted();
    const statuses = unwrap(await client.session.status({ directory }, options));
    if ([...targets].every((id) => !statuses[id] || statuses[id].type === "idle")) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}
