const SEARCH_HIGHLIGHT_MARK_ATTR = "data-search-highlight";
export const SEARCH_HIGHLIGHT_SELECTOR = `mark[${SEARCH_HIGHLIGHT_MARK_ATTR}="true"]`;
const SEARCH_HIGHLIGHT_CLASS_NAME = "rounded px-0.5 bg-amber-4/70 text-current";
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type TextHighlightPart = {
  text: string;
  highlighted: boolean;
};

export function textHighlightParts(value: string, query: string): TextHighlightPart[] {
  const needle = query.trim().toLowerCase();

  if (!needle || !value) {
    return value ? [{ text: value, highlighted: false }] : [];
  }

  const lower = value.toLowerCase();

  if (!lower.includes(needle)) {
    return [{ text: value, highlighted: false }];
  }

  const needlePattern = new RegExp(escapeRegExp(needle), "g");
  const parts: TextHighlightPart[] = [];
  let searchIndex = 0;

  for (const match of lower.matchAll(needlePattern)) {
    const matchIndex = match.index;

    if (matchIndex > searchIndex) {
      parts.push({ text: value.slice(searchIndex, matchIndex), highlighted: false });
    }

    parts.push({ text: value.slice(matchIndex, matchIndex + needle.length), highlighted: true });
    searchIndex = matchIndex + needle.length;
  }

  if (searchIndex < value.length) {
    parts.push({ text: value.slice(searchIndex), highlighted: false });
  }

  return parts;
}

export function clearTextHighlights(root: HTMLElement) {
  const marks = root.querySelectorAll(SEARCH_HIGHLIGHT_SELECTOR);

  for (const mark of marks) {
    const parent = mark.parentNode;

    if (!parent) {
      continue;
    }

    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
  }

  root.normalize();
}

export function applyTextHighlights(root: HTMLElement, query: string) {
  const needle = query.trim().toLowerCase();
  // Fast path: if search is inactive, avoid walking large message DOM trees.
  // We only need to clear existing marks if a previous search actually added
  // some.
  if (!needle) {
    if (root.querySelector(SEARCH_HIGHLIGHT_SELECTOR)) {
      clearTextHighlights(root);
    }

    return;
  }

  clearTextHighlights(root);

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue;

      if (!value || !value.trim()) {
        return NodeFilter.FILTER_REJECT;
      }

      const parent = node.parentElement;

      if (!parent) {
        return NodeFilter.FILTER_REJECT;
      }

      // `.katex` is excluded because injecting <mark> into rendered math corrupts
      // KaTeX's layout spans, and its MathML branch duplicates the visible text.
      if (parent.closest("pre, code, .katex")) {
        return NodeFilter.FILTER_REJECT;
      }

      if (parent.tagName === "SCRIPT" || parent.tagName === "STYLE") {
        return NodeFilter.FILTER_REJECT;
      }

      return value.toLowerCase().includes(needle)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    if (current instanceof Text) {
      nodes.push(current);
    }
    current = walker.nextNode();
  }

  for (const node of nodes) {
    const text = node.nodeValue ?? "";
    const fragment = document.createDocumentFragment();

    for (const part of textHighlightParts(text, needle)) {
      if (!part.highlighted) {
        fragment.appendChild(document.createTextNode(part.text));
        continue;
      }

      const mark = document.createElement("mark");
      mark.setAttribute(SEARCH_HIGHLIGHT_MARK_ATTR, "true");
      mark.className = SEARCH_HIGHLIGHT_CLASS_NAME;
      mark.textContent = part.text;
      fragment.appendChild(mark);
    }

    node.parentNode?.replaceChild(fragment, node);
  }
}
