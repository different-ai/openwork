/**
 * A coworker can hold several discussions at once. Each one is a native
 * engine thread; this registry, kept as `discussions.json` beside
 * `coworker.md`, records which of the workspace's threads are discussions so
 * they never show up as assignments. The coworker record's
 * `conversationThreadId` stays the pointer to the discussion that is open.
 */
export const DISCUSSION_REGISTRY_FILE = "discussions.json";

const MAX_DISCUSSION_TITLE = 60;

type DiscussionRegistry = { schemaVersion: 1; threadIds: string[] };

function isThreadId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Tolerant read: a missing, empty, or malformed file is simply an empty registry. */
export function parseDiscussionRegistry(text: string | null | undefined): string[] {
  if (!text || !text.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    const ids = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { threadIds?: unknown }).threadIds)
        ? (parsed as { threadIds: unknown[] }).threadIds
        : [];
    return withoutDuplicates(ids.filter(isThreadId).map((id) => id.trim()));
  } catch {
    return [];
  }
}

export function serializeDiscussionRegistry(threadIds: readonly string[]): string {
  const registry: DiscussionRegistry = { schemaVersion: 1, threadIds: withoutDuplicates(threadIds) };
  return `${JSON.stringify(registry, null, 2)}\n`;
}

function withoutDuplicates(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** The registry plus the open discussion, which older records know only by `conversationThreadId`. */
export function discussionIds(registry: readonly string[], conversationThreadId?: string): string[] {
  const open = conversationThreadId?.trim();
  return withoutDuplicates(open ? [...registry, open] : [...registry]);
}

/** Discussions never count as assignments, whichever way they are listed. */
export function splitDiscussionThreads<T extends { id: string }>(
  threads: readonly T[],
  ids: Iterable<string>,
): { discussions: T[]; assignments: T[] } {
  const set = new Set(ids);
  const discussions: T[] = [];
  const assignments: T[] = [];
  for (const thread of threads) {
    (set.has(thread.id) ? discussions : assignments).push(thread);
  }
  return { discussions, assignments };
}

/**
 * A discussion is titled after its first message. Until then it carries the
 * default title, which reads as "New discussion" wherever discussions are
 * listed — the coworker's name is already in the header above.
 */
export function discussionLabel(title: string, defaultTitle: string): string {
  const trimmed = title.trim();
  return !trimmed || trimmed === defaultTitle.trim() ? "New discussion" : trimmed;
}

export function discussionTitleFromPrompt(prompt: string): string {
  const firstLine = prompt
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => line.length > 0) ?? "";
  if (!firstLine) return "";
  return firstLine.length > MAX_DISCUSSION_TITLE ? `${firstLine.slice(0, MAX_DISCUSSION_TITLE - 1).trimEnd()}…` : firstLine;
}

// ---------------------------------------------------------------------------
// File-backed registry with a renderer-side cache. The file access is injected
// by the UI layer (the main-process bridge is not loadable in plain tests);
// until then reads answer with an empty registry. Every write goes through
// here, so the cache stays coherent for the app's lifetime.

export type DiscussionStoreIO = {
  readFile: (slug: string, path: string) => Promise<string>;
  writeFile: (slug: string, path: string, content: string) => Promise<unknown>;
  listCoworkers: () => Promise<ReadonlyArray<{ slug: string; workspaceId: string }>>;
};

let io: DiscussionStoreIO | null = null;
const registryBySlug = new Map<string, string[]>();
let slugByWorkspace = new Map<string, string>();

export function configureDiscussionStore(next: DiscussionStoreIO | null): void {
  io = next;
  registryBySlug.clear();
  slugByWorkspace = new Map();
}

function isMissingFile(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /ENOENT|no such file/i.test(message);
}

export async function loadDiscussionRegistry(slug: string): Promise<string[]> {
  const cached = registryBySlug.get(slug);
  if (cached) return cached;
  if (!io) return [];
  let ids: string[] = [];
  try {
    ids = parseDiscussionRegistry(await io.readFile(slug, DISCUSSION_REGISTRY_FILE));
  } catch (cause) {
    if (!isMissingFile(cause)) throw cause;
  }
  registryBySlug.set(slug, ids);
  return ids;
}

/** Record a thread as one of this coworker's discussions; returns the full registry. */
export async function registerDiscussion(slug: string, threadId: string): Promise<string[]> {
  const current = await loadDiscussionRegistry(slug);
  if (current.includes(threadId)) return current;
  if (!io) throw new Error("The discussion registry is not available.");
  const next = [...current, threadId];
  await io.writeFile(slug, DISCUSSION_REGISTRY_FILE, serializeDiscussionRegistry(next));
  registryBySlug.set(slug, next);
  return next;
}

/** Let activity reads find a coworker's registry when they only know the workspace. */
export function rememberWorkspaceSlug(workspaceId: string, slug: string): void {
  if (workspaceId && slug) slugByWorkspace.set(workspaceId, slug);
}

async function slugForWorkspace(workspaceId: string): Promise<string | undefined> {
  const known = slugByWorkspace.get(workspaceId);
  if (known) return known;
  if (!io) return undefined;
  const coworkers = await io.listCoworkers();
  const refreshed = new Map(slugByWorkspace);
  for (const coworker of coworkers) {
    if (coworker.workspaceId) refreshed.set(coworker.workspaceId, coworker.slug);
  }
  slugByWorkspace = refreshed;
  return slugByWorkspace.get(workspaceId);
}

/** Every discussion thread id for a workspace, including the open one. */
export async function discussionIdsForWorkspace(workspaceId: string, conversationThreadId?: string): Promise<string[]> {
  const slug = await slugForWorkspace(workspaceId);
  const registry = slug ? await loadDiscussionRegistry(slug) : [];
  return discussionIds(registry, conversationThreadId);
}
