/**
 * The newest page of each chat, kept on this device so the chat opens on it at once next time (`instantOpen`), while
 * it is read again. Kept per signed-in person, workspace and chat; only a conversation that wasn't answering when it
 * was read, so what shows first is never a reply in progress; for a week at most; and all of it goes on sign-out.
 */
const PREFIX = "workbot.thread.v1:";
const MAX_AGE_MS = 7 * 86_400_000;
/** As many turns as the first read shows (WORKBOT_FIRST_TURNS). */
const KEPT_TURNS = 8;

type Identity = { principalId: string; organizationId: string } | undefined;
type Snapshot = { available: boolean; status?: string; turns?: unknown[]; hasEarlier?: boolean };

const keyOf = (identity: NonNullable<Identity>, chat: string | null) => `${PREFIX}${identity.organizationId}:${identity.principalId}:${chat ?? "main"}`;

/** The kept page for this person and chat, unchecked; the caller validates it. Undefined when there is none. */
export function loadThreadSnapshot(identity: Identity, chat: string | null): unknown {
  if (!identity) return undefined;
  try {
    const raw = window.localStorage.getItem(keyOf(identity, chat));
    if (!raw) return undefined;
    const kept: unknown = JSON.parse(raw);
    if (typeof kept !== "object" || kept === null || !("savedAt" in kept) || typeof kept.savedAt !== "number" || !("thread" in kept)) return undefined;
    if (Date.now() - kept.savedAt > MAX_AGE_MS) { window.localStorage.removeItem(keyOf(identity, chat)); return undefined; }
    return kept.thread;
  } catch {
    return undefined;
  }
}

/** Keeps the newest page of a conversation that is available and not answering. */
export function saveThreadSnapshot(identity: Identity, chat: string | null, thread: Snapshot) {
  if (!identity || !thread.available || thread.status !== "idle" || !thread.turns?.length) return;
  const turns = thread.turns.slice(-KEPT_TURNS);
  const kept = { ...thread, turns, hasEarlier: thread.hasEarlier === true || turns.length < thread.turns.length };
  try {
    window.localStorage.setItem(keyOf(identity, chat), JSON.stringify({ savedAt: Date.now(), thread: kept }));
  } catch {
    // Storage full or off: the chat just opens the way it did before.
  }
}

/** Forgets every kept page on this device: on sign-out, and when the feature is off. */
export function clearThreadSnapshots() {
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(PREFIX)) window.localStorage.removeItem(key);
    }
  } catch {
    // Storage off: nothing was kept.
  }
}
