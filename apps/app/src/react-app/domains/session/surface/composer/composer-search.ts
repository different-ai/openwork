import fuzzysort from "fuzzysort";

export type ComposerSearchEntry<T> = {
  id: string;
  label: string;
  keywords?: string[];
  value: T;
};

export type ComposerSearchTier = "exact" | "prefix" | "word-start" | "fuzzy" | "keyword" | "typo";

export type ComposerSearchMatch<T> = {
  entry: ComposerSearchEntry<T>;
  tier: ComposerSearchTier;
  score: number;
  highlights: number[];
};

export type ComposerHighlightSegment = {
  text: string;
  match: boolean;
};

const TIER_WEIGHT: Record<ComposerSearchTier, number> = {
  exact: 6,
  prefix: 5,
  "word-start": 4,
  fuzzy: 3,
  keyword: 2,
  typo: 1,
};

type Word = { text: string; start: number };

export function normalizeComposerQuery(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, " ").trim();
}

function splitWords(label: string): Word[] {
  const words: Word[] = [];
  const pattern = /[\p{L}\p{N}]+/gu;
  for (const match of label.matchAll(pattern)) {
    words.push({ text: match[0].toLowerCase(), start: match.index ?? 0 });
  }
  return words;
}

function range(start: number, length: number): number[] {
  return Array.from({ length }, (_, offset) => start + offset);
}

function wordStartHighlights(words: Word[], tokens: string[]): number[] | null {
  const used = new Set<number>();
  const highlights: number[] = [];
  for (const token of tokens) {
    const index = words.findIndex((word, position) => !used.has(position) && word.text.startsWith(token));
    if (index < 0) return null;
    used.add(index);
    highlights.push(...range(words[index].start, token.length));
  }
  return highlights.sort((a, b) => a - b);
}

export function damerauLevenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const distance: number[][] = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: cols }, (_, col) => (row === 0 ? col : col === 0 ? row : 0)),
  );
  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1;
      distance[row][col] = Math.min(
        distance[row - 1][col] + 1,
        distance[row][col - 1] + 1,
        distance[row - 1][col - 1] + cost,
      );
      if (row > 1 && col > 1 && a[row - 1] === b[col - 2] && a[row - 2] === b[col - 1]) {
        distance[row][col] = Math.min(distance[row][col], distance[row - 2][col - 2] + 1);
      }
    }
  }
  return distance[a.length][b.length];
}

function allowedTypos(token: string): number {
  if (token.length >= 7) return 2;
  if (token.length >= 4) return 1;
  return 0;
}

function typoHighlights(words: Word[], tokens: string[]): { highlights: number[]; typos: number } | null {
  const used = new Set<number>();
  const highlights: number[] = [];
  let typos = 0;
  for (const token of tokens) {
    const budget = allowedTypos(token);
    let best: { index: number; cost: number; length: number } | null = null;
    words.forEach((word, index) => {
      if (used.has(index)) return;
      for (const length of [token.length - 1, token.length, token.length + 1]) {
        if (length < 1 || length > word.text.length) continue;
        const cost = damerauLevenshtein(token, word.text.slice(0, length));
        if (cost <= budget && (!best || cost < best.cost)) best = { index, cost, length };
      }
    });
    if (!best) return null;
    const chosen: { index: number; cost: number; length: number } = best;
    used.add(chosen.index);
    typos += chosen.cost;
    highlights.push(...range(words[chosen.index].start, chosen.length));
  }
  return { highlights: highlights.sort((a, b) => a - b), typos };
}

function matchEntry<T>(query: string, entry: ComposerSearchEntry<T>): ComposerSearchMatch<T> | null {
  const label = entry.label;
  const normalizedLabel = normalizeComposerQuery(label);
  if (normalizedLabel === query) {
    return { entry, tier: "exact", score: 1, highlights: range(0, label.length) };
  }
  if (label.toLowerCase().startsWith(query)) {
    return { entry, tier: "prefix", score: 1 - label.length / 1000, highlights: range(0, query.length) };
  }
  const tokens = query.split(" ");
  const words = splitWords(label);
  const wordStart = wordStartHighlights(words, tokens);
  if (wordStart) {
    return { entry, tier: "word-start", score: 1 - label.length / 1000, highlights: wordStart };
  }
  const fuzzy = fuzzysort.single(query, label);
  if (fuzzy) {
    // A query that covers most of a short label ("hbspt" in "HubSpot") beats a
    // tighter run inside a long one ("Hubspot deal summary").
    const coverage = query.replace(/\s/g, "").length / Math.max(1, label.replace(/\s/g, "").length);
    return {
      entry,
      tier: "fuzzy",
      score: fuzzy.score * 0.6 + Math.min(1, coverage) * 0.4,
      highlights: [...fuzzy.indexes].sort((a, b) => a - b),
    };
  }
  const keywordText = (entry.keywords ?? []).filter(Boolean).join(" ");
  if (keywordText) {
    const keywordWords = splitWords(keywordText);
    if (wordStartHighlights(keywordWords, tokens)) {
      return { entry, tier: "keyword", score: 1, highlights: [] };
    }
    const keywordFuzzy = fuzzysort.single(query, keywordText);
    if (keywordFuzzy && keywordFuzzy.score > 0.5) {
      return { entry, tier: "keyword", score: keywordFuzzy.score, highlights: [] };
    }
  }
  const typo = typoHighlights(words, tokens);
  if (typo) {
    return { entry, tier: "typo", score: 1 / (1 + typo.typos), highlights: typo.highlights };
  }
  return null;
}

function compareMatches<T>(a: ComposerSearchMatch<T>, b: ComposerSearchMatch<T>): number {
  const tier = TIER_WEIGHT[b.tier] - TIER_WEIGHT[a.tier];
  if (tier !== 0) return tier;
  if (b.score !== a.score) return b.score - a.score;
  if (a.entry.label.length !== b.entry.label.length) return a.entry.label.length - b.entry.label.length;
  return a.entry.label.localeCompare(b.entry.label);
}

export function rankComposerSearch<T>(
  query: string,
  entries: ComposerSearchEntry<T>[],
  options: { limit?: number } = {},
): ComposerSearchMatch<T>[] {
  const normalized = normalizeComposerQuery(query);
  if (!normalized) return [];
  const matches: ComposerSearchMatch<T>[] = [];
  for (const entry of entries) {
    const match = matchEntry(normalized, entry);
    if (match) matches.push(match);
  }
  matches.sort(compareMatches);
  return typeof options.limit === "number" ? matches.slice(0, options.limit) : matches;
}

export function composerHighlightSegments(label: string, highlights: number[]): ComposerHighlightSegment[] {
  if (highlights.length === 0) return label ? [{ text: label, match: false }] : [];
  const marked = new Set(highlights);
  const segments: ComposerHighlightSegment[] = [];
  for (let index = 0; index < label.length; index += 1) {
    const match = marked.has(index);
    const last = segments[segments.length - 1];
    if (last && last.match === match) last.text += label[index];
    else segments.push({ text: label[index], match });
  }
  return segments;
}
