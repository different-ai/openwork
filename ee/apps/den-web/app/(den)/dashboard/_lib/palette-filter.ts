import { defaultFilter } from "cmdk";

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function paletteFilter(value: string, search: string, keywords?: string[]): number {
  const query = normalize(search);
  if (!query) return 1;

  const label = normalize(keywords?.[0] ?? value);
  const normalizedKeywords = (keywords ?? []).map(normalize);
  const tokens = query.split(" ");
  const searchable = normalize([label, ...normalizedKeywords].join(" "));
  if (
    tokens.length >= 2
    && !tokens.every((token) => searchable.includes(token))
  ) {
    return 0;
  }

  if (label === query) return 1;
  if (label.startsWith(query)) return 0.95;
  if (label.includes(query)) return 0.9;

  const aliasIndex = normalizedKeywords.findIndex(
    (keyword, index) => index >= 1 && keyword.includes(query),
  );
  if (aliasIndex >= 1) {
    return 0.85 - Math.min(aliasIndex, 10) * 0.02;
  }

  return Math.max(0, defaultFilter(value, search, keywords) * 0.4);
}
