import { useMemo, useState } from "react";

const DEFAULT_PAGE_SIZE = 50;

export function useOrgListWindow<T extends { name?: string | null; slug?: string | null }>(
  orgs: T[],
  pageSize = DEFAULT_PAGE_SIZE,
) {
  const [query, setQueryState] = useState("");
  const [visibleCount, setVisibleCount] = useState(pageSize);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orgs;

    return orgs.filter((org) => {
      const name = org.name?.toLowerCase() ?? "";
      const slug = org.slug?.toLowerCase() ?? "";
      return name.includes(q) || slug.includes(q);
    });
  }, [orgs, query]);

  const visible = filtered.slice(0, visibleCount);
  const hiddenCount = filtered.length - visible.length;

  return {
    query,
    setQuery: (next: string) => {
      setQueryState(next);
      setVisibleCount(pageSize);
    },
    visible,
    filteredCount: filtered.length,
    totalCount: orgs.length,
    hiddenCount,
    hasMore: hiddenCount > 0,
    showMore: () => setVisibleCount((count) => count + pageSize),
    showSearch: orgs.length > 10,
  };
}
