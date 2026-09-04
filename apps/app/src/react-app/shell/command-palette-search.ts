import fuzzysort from "fuzzysort";

export type PaletteGroup = "recent" | "actions" | "settings" | "sessions";

export type PaletteItem = {
  id: string;
  title: string;
  detail?: string;
  meta?: string;
  searchText?: string;
  keywords?: string[];
  group?: PaletteGroup;
  breadcrumb?: string;
  shortcut?: string;
  disabled?: boolean;
  action: () => void;
};

export type PaletteResultGroup = {
  value: PaletteGroup;
  label: string;
  items: PaletteItem[];
};

const GROUP_ORDER: PaletteGroup[] = ["recent", "actions", "settings", "sessions"];
const GROUP_LABELS: Record<PaletteGroup, string> = {
  recent: "Recent",
  actions: "Actions",
  settings: "Settings",
  sessions: "Sessions",
};

function itemGroup(item: PaletteItem): PaletteGroup {
  return item.group ?? "actions";
}

function itemKeywords(item: PaletteItem) {
  return [...(item.keywords ?? []), item.searchText ?? ""].join(" ");
}

function itemSearchText(item: PaletteItem) {
  return [item.title, itemKeywords(item), item.breadcrumb, item.detail]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function resultGroup(value: PaletteGroup, items: PaletteItem[]): PaletteResultGroup {
  return { value, label: GROUP_LABELS[value], items };
}

export function rankPaletteItems(
  query: string,
  items: PaletteItem[],
  recentIds: string[],
): PaletteResultGroup[] {
  const trimmed = query.trim();
  if (!trimmed) {
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const recent = recentIds
      .flatMap((id) => {
        const item = itemsById.get(id);
        return item ? [item] : [];
      })
      .slice(0, 8);
    const recentIdSet = new Set(recent.map((item) => item.id));
    const nonRecentItems = items.filter((item) => !recentIdSet.has(item.id));
    const groups = [
      resultGroup("recent", recent),
      resultGroup("actions", nonRecentItems.filter((item) => itemGroup(item) === "actions")),
      resultGroup("settings", nonRecentItems.filter((item) => itemGroup(item) === "settings").slice(0, 6)),
      resultGroup("sessions", nonRecentItems.filter((item) => itemGroup(item) === "sessions").slice(0, 5)),
    ];
    return groups.filter((group) => group.items.length > 0);
  }

  const actionsOnly = trimmed.startsWith(">");
  const searchQuery = actionsOnly ? trimmed.slice(1).trim() : trimmed;
  const candidates = actionsOnly
    ? items.filter((item) => itemGroup(item) === "actions")
    : items;

  if (!searchQuery) {
    return candidates.length > 0 ? [resultGroup("actions", candidates.slice(0, 40))] : [];
  }

  const normalizedQuery = normalizeSearchText(searchQuery);
  const tokens = normalizedQuery.split(" ");
  const tokenMatchedItems = candidates.filter((item) => {
    const text = itemSearchText(item);
    return tokens.every((token) => fuzzysort.single(token, text) !== null);
  });
  const recentIdSet = new Set(recentIds);
  const ranked = fuzzysort.go(searchQuery, tokenMatchedItems, {
    keys: [
      (item) => item.title,
      (item) => itemKeywords(item),
      (item) => item.breadcrumb ?? "",
      (item) => item.detail ?? "",
    ],
    threshold: 0.1,
    limit: 40,
    scoreFn: (result) => {
      const score = Math.max(
        result[0].score * 2,
        result[1].score,
        result[2].score * 0.6,
        result[3].score * 0.8,
      );
      const tier = normalizeSearchText(result.obj.title).includes(normalizedQuery)
        ? 3
        : normalizeSearchText(itemKeywords(result.obj)).includes(normalizedQuery)
          ? 2
          : 1;
      const boostedScore = recentIdSet.has(result.obj.id) ? score * 1.1 : score;
      return tier * 10 + boostedScore;
    },
  }).map((result) => result.obj);

  const bestGroup = ranked[0] ? itemGroup(ranked[0]) : null;
  const groupOrder = bestGroup
    ? [bestGroup, ...GROUP_ORDER.filter((group) => group !== bestGroup)]
    : GROUP_ORDER;

  return groupOrder.flatMap((group) => {
    const groupItems = ranked.filter((item) => itemGroup(item) === group);
    return groupItems.length > 0 ? [resultGroup(group, groupItems)] : [];
  });
}
