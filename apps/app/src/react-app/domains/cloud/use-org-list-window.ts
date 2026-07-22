import { useCallback, useMemo, useState } from "react";

export const ORG_LIST_PAGE_SIZE = 50;

type OrgListWindowItem = {
  name: string;
  slug: string;
};

export function useOrgListWindow<TOrg extends OrgListWindowItem>(orgs: TOrg[]) {
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(ORG_LIST_PAGE_SIZE);
  const normalizedQuery = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!normalizedQuery) return orgs;

    return orgs.filter((org) => {
      const name = org.name.toLowerCase();
      const slug = org.slug.toLowerCase();

      return name.includes(normalizedQuery) || slug.includes(normalizedQuery);
    });
  }, [normalizedQuery, orgs]);

  const visible = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  );

  const updateQuery = useCallback((nextQuery: string) => {
    setQuery(nextQuery);
    setVisibleCount(ORG_LIST_PAGE_SIZE);
  }, []);

  const showMore = useCallback(() => {
    setVisibleCount((count) => count + ORG_LIST_PAGE_SIZE);
  }, []);

  return {
    filtered,
    query,
    showMore,
    updateQuery,
    visible,
  };
}
