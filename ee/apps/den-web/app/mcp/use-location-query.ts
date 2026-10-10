"use client";

import { useEffect, useState } from "react";

/**
 * The page's query string without the leading "?", read after mount so the
 * server render and the first client render match. Null until then.
 */
export function useLocationQuery(): string | null {
  const [query, setQuery] = useState<string | null>(null);
  useEffect(() => {
    setQuery(window.location.search.replace(/^\?/, ""));
  }, []);
  return query;
}
