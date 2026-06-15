const SEARCH_HIGHLIGHT_MARK_ATTR = "data-search-highlight";
const SEARCH_HIGHLIGHT_ACTIVE_ATTR = "data-search-active";
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function clearTextHighlights(root: HTMLElement) {
  const marks = root.querySelectorAll(`mark[${SEARCH_HIGHLIGHT_MARK_ATTR}="true"]`);
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
  });
  root.normalize();
}

export function scrollActiveMatchIntoView(root: HTMLElement) {
  const active = root.querySelector(`mark[${SEARCH_HIGHLIGHT_ACTIVE_ATTR}="true"]`);
  const target = active ?? root.querySelector(`mark[${SEARCH_HIGHLIGHT_MARK_ATTR}="true"]`);
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
}

export function applyTextHighlights(root: HTMLElement, query: string, activeIndex = 0) {
  const needle = query.trim().toLowerCase();
  // Fast path: if search is inactive, avoid walking large message DOM trees.
  // We only need to clear existing marks if a previous search actually added
  // some.
  if (!needle) {
    if (root.querySelector(`mark[${SEARCH_HIGHLIGHT_MARK_ATTR}="true"]`)) {
      clearTextHighlights(root);
    }
    return;
  }

  clearTextHighlights(root);
  const needlePattern = new RegExp(escapeRegExp(needle), "g");

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue ?? "";
      if (!value.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("pre, code")) return NodeFilter.FILTER_REJECT;
      if (parent.tagName === "SCRIPT" || parent.tagName === "STYLE") return NodeFilter.FILTER_REJECT;
      return value.toLowerCase().includes(needle)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }

  let matchCounter = 0;

  nodes.forEach((node) => {
    const text = node.nodeValue ?? "";
    const lower = text.toLowerCase();
    let searchIndex = 0;
    const fragment = document.createDocumentFragment();

    for (const match of lower.matchAll(needlePattern)) {
      const matchIndex = match.index;

      if (matchIndex > searchIndex) {
        fragment.appendChild(document.createTextNode(text.slice(searchIndex, matchIndex)));
      }

      const mark = document.createElement("mark");
      mark.setAttribute(SEARCH_HIGHLIGHT_MARK_ATTR, "true");
      if (matchCounter === activeIndex) {
        mark.setAttribute(SEARCH_HIGHLIGHT_ACTIVE_ATTR, "true");
        mark.className = "rounded px-0.5 bg-primary/35 ring-1 ring-primary/50 text-current";
      } else {
        mark.className = "rounded px-0.5 bg-amber-4/70 text-current";
      }
      matchCounter += 1;
      mark.textContent = text.slice(matchIndex, matchIndex + needle.length);
      fragment.appendChild(mark);
      searchIndex = matchIndex + needle.length;
    }
    if (searchIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(searchIndex)));
    }

    node.parentNode?.replaceChild(fragment, node);
  });
}
