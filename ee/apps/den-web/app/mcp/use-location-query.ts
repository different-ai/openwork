"use client";

import { useEffect, useState } from "react";

export function useLocationQuery(): string | null {
  const [query, setQuery] = useState<string | null>(null);
  useEffect(() => {
    setQuery(window.location.search.replace(/^\?/, ""));
  }, []);
  return query;
}
