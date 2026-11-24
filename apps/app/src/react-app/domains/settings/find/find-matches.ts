export const FIND_MIN_QUERY_LENGTH = 2;

const FIND_MAX_MATCHES = 1000;

const SKIPPED = "script, style, .sr-only";

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type TextMatch = { start: number; end: number };

export function findTextMatches(text: string, query: string): TextMatch[] {
  const needle = query.trim();
  if (!needle || !text) return [];
  const matches: TextMatch[] = [];
  for (const match of text.matchAll(new RegExp(escapeRegExp(needle), "giu"))) {
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return matches;
}

function isShown(element: Element) {
  return typeof element.checkVisibility === "function" ? element.checkVisibility({ visibilityProperty: true }) : true;
}

export function collectFindRanges(
  root: Node,
  query: string,
  shown: (element: Element) => boolean = isShown,
): Range[] {
  const needle = query.trim();
  if (needle.length < FIND_MIN_QUERY_LENGTH) return [];
  const document = root.ownerDocument;
  if (!document) return [];

  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && ranges.length < FIND_MAX_MATCHES; node = walker.nextNode()) {
    const matches = findTextMatches(node.nodeValue ?? "", needle);
    if (matches.length === 0) continue;
    const parent = node.parentElement;
    if (!parent || parent.closest(SKIPPED) || !shown(parent)) continue;
    for (const match of matches) {
      const range = document.createRange();
      range.setStart(node, match.start);
      range.setEnd(node, match.end);
      ranges.push(range);
    }
  }
  return ranges.slice(0, FIND_MAX_MATCHES);
}

export function wrappedMatchIndex(index: number, step: number, total: number) {
  if (total <= 0) return 0;
  const remainder = (index + step) % total;
  return remainder < 0 ? remainder + total : remainder;
}
