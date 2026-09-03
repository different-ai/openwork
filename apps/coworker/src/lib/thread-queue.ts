/**
 * What the person has said to a discussion that the coworker has not answered
 * yet: the turn in flight, and the messages typed while it ran, which wait as
 * **Next** and go one at a time, in order, each as its own turn.
 *
 * Both live in `turns.json` beside `coworker.md`, one entry per thread, so a
 * quit or reload loses nothing: the turn in flight can be told from one that
 * was cut off, and Next is still there when the app comes back. The pure
 * functions below own the shape; the store at the bottom reads and writes the
 * file through injected IO (the main-process bridge in the app, memory in
 * tests) and keeps one coherent cache per coworker.
 */
export const TURNS_FILE = "turns.json";

export type QueuedMessage = {
  id: string;
  text: string;
  queuedAt: number;
};

export type PendingTurnRecord = {
  messageId: string;
  prompt: string;
  startedAt: number;
  /** When the person pressed Stop; null while the turn is in flight or was cut off. */
  stoppedAt: number | null;
};

export type ThreadTurnState = {
  pending: PendingTurnRecord | null;
  next: QueuedMessage[];
};

export type TurnsFile = {
  schemaVersion: 1;
  threads: Record<string, ThreadTurnState>;
};

export const EMPTY_THREAD_TURNS: ThreadTurnState = { pending: null, next: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parsePending(value: unknown): PendingTurnRecord | null {
  if (!isRecord(value) || typeof value.messageId !== "string" || !value.messageId || typeof value.prompt !== "string") return null;
  return {
    messageId: value.messageId,
    prompt: value.prompt,
    startedAt: finite(value.startedAt) ?? 0,
    stoppedAt: finite(value.stoppedAt),
  };
}

function parseQueued(value: unknown): QueuedMessage | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.text !== "string" || !value.text.trim()) return null;
  return { id: value.id, text: value.text, queuedAt: finite(value.queuedAt) ?? 0 };
}

/** Tolerant read: a missing, empty, or malformed file is simply no unfinished turns anywhere. */
export function parseTurnsFile(text: string | null | undefined): TurnsFile {
  const file: TurnsFile = { schemaVersion: 1, threads: {} };
  if (!text || !text.trim()) return file;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || !isRecord(parsed.threads)) return file;
    for (const [threadId, state] of Object.entries(parsed.threads)) {
      if (!threadId || !isRecord(state)) continue;
      const next = Array.isArray(state.next) ? state.next.map(parseQueued).filter((item): item is QueuedMessage => item !== null) : [];
      const pending = parsePending(state.pending);
      if (pending || next.length > 0) file.threads[threadId] = { pending, next };
    }
    return file;
  } catch {
    return file;
  }
}

/** Threads with nothing unfinished are dropped, so the file only ever names what still matters. */
export function serializeTurnsFile(file: TurnsFile): string {
  const threads: Record<string, ThreadTurnState> = {};
  for (const [threadId, state] of Object.entries(file.threads)) {
    if (state.pending || state.next.length > 0) threads[threadId] = { pending: state.pending, next: state.next };
  }
  return `${JSON.stringify({ schemaVersion: 1, threads }, null, 2)}\n`;
}

export function threadTurns(file: TurnsFile, threadId: string): ThreadTurnState {
  return file.threads[threadId] ?? EMPTY_THREAD_TURNS;
}

export function withThreadTurns(file: TurnsFile, threadId: string, state: ThreadTurnState): TurnsFile {
  const threads = { ...file.threads };
  if (state.pending || state.next.length > 0) threads[threadId] = state;
  else delete threads[threadId];
  return { schemaVersion: 1, threads };
}

// --- the pure operations on one thread's state ---------------------------------

export function enqueue(state: ThreadTurnState, message: QueuedMessage): ThreadTurnState {
  const text = message.text.trim();
  if (!text || state.next.some((item) => item.id === message.id)) return state;
  return { ...state, next: [...state.next, { ...message, text }] };
}

export function removeQueued(state: ThreadTurnState, id: string): ThreadTurnState {
  if (!state.next.some((item) => item.id === id)) return state;
  return { ...state, next: state.next.filter((item) => item.id !== id) };
}

/** Take the first waiting message off the queue: what goes next once the turn settles. */
export function dequeue(state: ThreadTurnState): { state: ThreadTurnState; message: QueuedMessage | null } {
  const [message, ...rest] = state.next;
  if (!message) return { state, message: null };
  return { state: { ...state, next: rest }, message };
}

/** Take one message out of the queue to send it right away, or to hand it back to the field. */
export function takeQueued(state: ThreadTurnState, id: string): { state: ThreadTurnState; message: QueuedMessage | null } {
  const message = state.next.find((item) => item.id === id) ?? null;
  if (!message) return { state, message: null };
  return { state: removeQueued(state, id), message };
}

export function beginPending(state: ThreadTurnState, turn: { messageId: string; prompt: string; startedAt: number }): ThreadTurnState {
  return { ...state, pending: { messageId: turn.messageId, prompt: turn.prompt, startedAt: turn.startedAt, stoppedAt: null } };
}

export function markStopped(state: ThreadTurnState, stoppedAt: number): ThreadTurnState {
  if (!state.pending) return state;
  return { ...state, pending: { ...state.pending, stoppedAt } };
}

/** The turn settled (a reply landed, or the person let it go): nothing is pending any more. */
export function clearPending(state: ThreadTurnState): ThreadTurnState {
  return state.pending ? { ...state, pending: null } : state;
}

// ---------------------------------------------------------------------------
// File-backed store with a renderer-side cache. The file access is injected by
// the UI layer (the main-process bridge is not loadable in plain tests); until
// then reads answer with nothing pending and writes are refused. Writes for one
// coworker are serialized so two threads never race on the same file.

export type TurnStoreIO = {
  readFile: (slug: string, path: string) => Promise<string>;
  writeFile: (slug: string, path: string, content: string) => Promise<unknown>;
};

let io: TurnStoreIO | null = null;
/** The first read of each coworker's file, shared by everyone who asks while it is in flight. */
const loadsBySlug = new Map<string, Promise<TurnsFile>>();
/** The latest known contents, kept current synchronously so two saves never lose each other's thread. */
const fileBySlug = new Map<string, TurnsFile>();
const writesBySlug = new Map<string, Promise<unknown>>();

export function configureTurnStore(next: TurnStoreIO | null): void {
  io = next;
  loadsBySlug.clear();
  fileBySlug.clear();
  writesBySlug.clear();
}

function isMissingFile(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /ENOENT|no such file/i.test(message);
}

async function readTurnsFile(slug: string): Promise<TurnsFile> {
  if (!io) return { schemaVersion: 1, threads: {} };
  try {
    return parseTurnsFile(await io.readFile(slug, TURNS_FILE));
  } catch (cause) {
    if (isMissingFile(cause)) return { schemaVersion: 1, threads: {} };
    throw cause;
  }
}

async function loadTurnsFile(slug: string): Promise<TurnsFile> {
  const cached = fileBySlug.get(slug);
  if (cached) return cached;
  let load = loadsBySlug.get(slug);
  if (!load) {
    load = readTurnsFile(slug).then((file) => {
      // A save that ran while the read was in flight already knows more than the disk did.
      const known = fileBySlug.get(slug);
      if (!known) fileBySlug.set(slug, file);
      return fileBySlug.get(slug) ?? file;
    });
    loadsBySlug.set(slug, load);
    load.catch(() => loadsBySlug.delete(slug));
  }
  return load;
}

/** What this thread still owes: the turn in flight or left unresolved, and the messages waiting as Next. */
export async function loadThreadTurns(slug: string, threadId: string): Promise<ThreadTurnState> {
  return threadTurns(await loadTurnsFile(slug), threadId);
}

/**
 * Replace one thread's state and write the file. The cache updates first so a
 * reader in the same window sees the change at once; the write itself is
 * queued behind any earlier write for the coworker.
 */
export async function saveThreadTurns(slug: string, threadId: string, state: ThreadTurnState): Promise<ThreadTurnState> {
  await loadTurnsFile(slug);
  // Read the cache again after the await: another save may have landed meanwhile.
  const file = withThreadTurns(fileBySlug.get(slug) ?? { schemaVersion: 1, threads: {} }, threadId, state);
  fileBySlug.set(slug, file);
  if (!io) return state;
  const store = io;
  const previous = writesBySlug.get(slug) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(() => store.writeFile(slug, TURNS_FILE, serializeTurnsFile(file)));
  writesBySlug.set(slug, write);
  try {
    await write;
  } finally {
    if (writesBySlug.get(slug) === write) writesBySlug.delete(slug);
  }
  return state;
}
