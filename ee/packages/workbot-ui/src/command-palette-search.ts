import fuzzysort from "fuzzysort";

/**
 * Ranking for Workbot's command palette: pure, so it is tested without a page.
 * The same idea as the desktop palette's search (apps/app/src/react-app/shell/command-palette-search.ts): fuzzy
 * match on the title first, then keywords and detail; recently used entries win ties.
 */

export type PaletteGroupId = "recent" | "actions" | "chats" | "tasks" | "navigation" | "settings";

export const PALETTE_GROUP_LABELS: Record<PaletteGroupId, string> = {
  recent: "Recent",
  actions: "Actions",
  chats: "Chats",
  tasks: "Background tasks",
  navigation: "Go to",
  settings: "Settings",
};

const GROUP_ORDER: readonly PaletteGroupId[] = ["actions", "chats", "tasks", "navigation", "settings"];

/** What the ranking needs from an entry. */
export type Rankable = {
  id: string;
  group: Exclude<PaletteGroupId, "recent">;
  title: string;
  detail?: string;
  keywords?: string;
  /** Shown when nothing is typed. Entries that only appear when searched (every chat, older tasks) set false. */
  preview?: boolean;
};

export type RankedGroup<T extends Rankable> = { value: PaletteGroupId; label: string; items: T[] };

/** The most entries a search lists, so a person with hundreds of chats still gets an instant, short list. */
export const SEARCH_LIMIT = 50;
const RECENT_LIMIT = 5;

function group<T extends Rankable>(value: PaletteGroupId, items: T[]): RankedGroup<T> {
  return { value, label: PALETTE_GROUP_LABELS[value], items };
}

function normalize(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function rankPaletteItems<T extends Rankable>(query: string, items: readonly T[], recentIds: readonly string[]): RankedGroup<T>[] {
  const trimmed = query.trim();
  if (!trimmed) {
    const byId = new Map(items.map((item) => [item.id, item]));
    const recent = recentIds.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    }).slice(0, RECENT_LIMIT);
    const shown = new Set(recent.map((item) => item.id));
    return [
      group("recent", recent),
      ...GROUP_ORDER.map((value) => group(value, items.filter((item) => item.group === value && item.preview !== false && !shown.has(item.id)))),
    ].filter((entry) => entry.items.length > 0);
  }

  const wanted = normalize(trimmed);
  const tokens = wanted.split(" ");
  const haystack = (item: T) => [item.title, item.keywords, item.detail].filter(Boolean).join(" ");
  // Every word has to match somewhere, so "side bud" finds the "Budget" side chat but not every side chat.
  const candidates = items.filter((item) => tokens.every((token) => fuzzysort.single(token, haystack(item)) !== null));
  const recent = new Set(recentIds);
  const ranked = fuzzysort.go(trimmed, candidates, {
    keys: [(item) => item.title, (item) => item.keywords ?? "", (item) => item.detail ?? ""],
    threshold: 0.3,
    limit: SEARCH_LIMIT,
    scoreFn: (result) => {
      const score = Math.max(result[0].score * 2, result[1].score, result[2].score * 0.7);
      const title = normalize(result.obj.title);
      const tier = title.startsWith(wanted) ? 4 : title.includes(wanted) ? 3 : normalize(result.obj.keywords ?? "").includes(wanted) ? 2 : 1;
      return tier * 10 + (recent.has(result.obj.id) ? score * 1.1 : score);
    },
  }).map((result) => result.obj);
  // Tokens that matched across fields but not as one phrase still count, after the phrase matches.
  const extra = tokens.length > 1 ? candidates.filter((item) => !ranked.includes(item)).slice(0, Math.max(0, SEARCH_LIMIT - ranked.length)) : [];
  const ordered = [...ranked, ...extra];
  const best = ordered[0]?.group;
  const order = best ? [best, ...GROUP_ORDER.filter((value) => value !== best)] : GROUP_ORDER;
  return order.flatMap((value) => {
    const entries = ordered.filter((item) => item.group === value);
    return entries.length > 0 ? [group(value, entries)] : [];
  });
}

/** Character positions of `query` in `text` to emphasize, or none. */
export function matchIndexes(query: string, text: string): ReadonlySet<number> {
  const trimmed = query.trim();
  if (!trimmed) return new Set();
  const whole = fuzzysort.single(trimmed, text);
  if (whole) return new Set(whole.indexes);
  const marked = new Set<number>();
  for (const token of normalize(trimmed).split(" ")) for (const index of fuzzysort.single(token, text)?.indexes ?? []) marked.add(index);
  return marked;
}

/** Split `text` into runs, each matched or not, for rendering emphasis without innerHTML. */
export function highlightRuns(text: string, marked: ReadonlySet<number>): Array<{ text: string; match: boolean }> {
  const runs: Array<{ text: string; match: boolean }> = [];
  for (let index = 0; index < text.length; index++) {
    const match = marked.has(index);
    const last = runs.at(-1);
    if (last && last.match === match) last.text += text[index];
    else runs.push({ text: text[index] ?? "", match });
  }
  return runs;
}

export const COMMAND_PALETTE_RECENTS_KEY = "workbot.command-palette.recents";
const RECENTS_KEPT = 8;

type RecentsStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): RecentsStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function loadPaletteRecents(storage: RecentsStorage | undefined = browserStorage()): string[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(COMMAND_PALETTE_RECENTS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => typeof id === "string"))].slice(0, RECENTS_KEPT);
  } catch {
    return [];
  }
}

export function recordPaletteRecent(id: string, storage: RecentsStorage | undefined = browserStorage()): string[] {
  const next = [id, ...loadPaletteRecents(storage).filter((entry) => entry !== id)].slice(0, RECENTS_KEPT);
  try {
    storage?.setItem(COMMAND_PALETTE_RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Storage off or full: the action still runs; it just isn't remembered.
  }
  return next;
}
