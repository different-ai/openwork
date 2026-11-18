// Names used by `::highlight()` in `app/index.css`.
const MATCHES = "settings-find";
const CURRENT_MATCH = "settings-find-current";

function highlightRegistry() {
  if (typeof CSS === "undefined" || typeof Highlight === "undefined") return null;
  return CSS.highlights ?? null;
}

/** Paints every match, and the one being visited more strongly. */
export function paintFindHighlights(ranges: Range[], current: Range | null) {
  const registry = highlightRegistry();
  if (!registry) return;
  if (ranges.length === 0) {
    clearFindHighlights();
    return;
  }
  registry.set(MATCHES, new Highlight(...ranges));
  if (!current) {
    registry.delete(CURRENT_MATCH);
    return;
  }
  const highlight = new Highlight(current);
  highlight.priority = 1;
  registry.set(CURRENT_MATCH, highlight);
}

export function clearFindHighlights() {
  const registry = highlightRegistry();
  registry?.delete(MATCHES);
  registry?.delete(CURRENT_MATCH);
}
