import { localPathName, parseLocalPathReference } from "@/react-app/domains/session/artifacts/local-path";

/** Portable selection copy for supported assistant prose, never arbitrary UI. */
export type AssistantProseClipboard = { html: string; text: string };

type Tag = "p" | "ul" | "ol" | "li" | "strong" | "em" | "s" | "hr" | "a" | "code" | "pre" | "br"
  | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote"
  | "table" | "thead" | "tbody" | "tfoot" | "tr" | "th" | "td";
type Content = { kind: "text"; value: string } | {
  kind: "element";
  tag: Tag;
  children: Content[];
  href?: string;
  start?: number;
};

const TAGS = new Set<string>([
  "p", "ul", "ol", "li", "strong", "em", "s", "hr", "a", "code", "pre", "br",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
]);
const HEADINGS = new Set<Tag>(["h1", "h2", "h3", "h4", "h5", "h6"]);
const BLOCKS = new Set<Tag>(["p", "ul", "ol", "li", "pre", "table", "hr", "blockquote", ...HEADINGS]);
const INLINE = new Set<Tag>(["strong", "em", "s", "a", "code", "br"]);
const isInline = (node: Content) => node.kind === "text" || INLINE.has(node.tag);
const meaningful = (node: Content) => node.kind !== "text" || Boolean(node.value.trim());

function validateChildren(tag: Tag, children: Content[]) {
  const content = children.filter(meaningful);
  if (tag === "p" || HEADINGS.has(tag) || INLINE.has(tag)) {
    if (!content.every(isInline)) return fail();
  } else if (tag === "ul" || tag === "ol") {
    if (!content.every(node => node.kind === "element" && node.tag === "li")) return fail();
  } else if (tag === "table" || tag === "thead" || tag === "tbody" || tag === "tfoot" || tag === "tr") {
    const allowed = tag === "table" ? ["thead", "tbody", "tfoot", "tr"] : tag === "tr" ? ["th", "td"] : ["tr"];
    if (!content.every(node => node.kind === "element" && allowed.includes(node.tag))) return fail();
  } else if (tag !== "pre" && !content.every(node => isInline(node) || (node.kind === "element" && BLOCKS.has(node.tag) && node.tag !== "li"))) {
    return fail();
  }
}
const ATOMIC = [
  ".katex", "math", ".mention", "[data-mention]", '[data-type="mention"]',
  "[data-lexical-mention]", "[data-openwork-session-reference]",
  "[data-openwork-untrusted-reference]", "[data-openwork-mermaid]", "[data-openwork-image]",
].join(",");
const EDITABLE = 'input,textarea,select,button,[contenteditable]:not([contenteditable="false"])';

/** Preserve semantic block boundaries without adding presentation or empty padding paragraphs. */
export function joinAssistantProseClipboard(pieces: readonly AssistantProseClipboard[]): AssistantProseClipboard | null {
  if (!pieces.length) return null;
  const text = pieces.map(piece => piece.text).join("\n\n");
  return text.length > 1_000_000 ? null : { html: pieces.map(piece => piece.html).join(""), text };
}

function isTag(tag: string): tag is Tag { return TAGS.has(tag); }
function element(tag: Tag, children: Content[]): Content { return { kind: "element", tag, children }; }
function fail(): never { throw new Error("Selection cannot be copied portably"); }
function escape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function parent(node: Node) { return node instanceof Element ? node : node.parentElement; }
function coversContents(range: Range, node: Node) {
  const content = node.ownerDocument?.createRange();
  if (!content) return false;
  content.selectNodeContents(node);
  return range.compareBoundaryPoints(Range.START_TO_START, content) <= 0
    && range.compareBoundaryPoints(Range.END_TO_END, content) >= 0;
}
function hrefFor(link: Element): string | undefined {
  const href = link.getAttribute("href");
  if (!href || /[\u0000-\u0020\u007f]/.test(href)) return undefined;
  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) ? href : undefined;
  } catch { return undefined; }
}
function filePathFor(link: Element) {
  if (hrefFor(link)) return undefined;
  // The renderer retains the Markdown destination here, before contextual resolution/expansion.
  const literal = link.getAttribute("data-openwork-link-href") ?? link.getAttribute("href");
  if (!literal || literal.trim().startsWith("#")) return undefined;
  const parsed = parseLocalPathReference(literal, { decode: true });
  return parsed ? { literal, name: localPathName(parsed.path) } : undefined;
}
function codeText(nodes: Content[]): string {
  return nodes.map(node => node.kind === "text" ? node.value : node.tag === "br" ? "\n" : codeText(node.children)).join("");
}
function htmlFor(node: Content): string {
  if (node.kind === "text") return escape(node.value);
  if (node.tag === "br") return "<br>";
  if (node.tag === "hr") return "<hr>";
  const href = node.href ? ` href="${escape(node.href)}"` : "";
  const start = node.tag === "ol" && node.start !== undefined && node.start !== 1 ? ` start="${node.start}"` : "";
  return `<${node.tag}${href}${start}>${node.children.map(htmlFor).join("")}</${node.tag}>`;
}
function textFor(node: Content, depth = 0): string {
  if (node.kind === "text") return node.value;
  if (node.tag === "br") return "\n";
  if (node.tag === "hr") return "---";
  if (node.tag === "pre" || node.tag === "code") return codeText(node.children);
  if (node.tag === "blockquote") {
    // Keep paragraph boundaries (including blank quoted lines) and every nested quote level.
    const paragraphs: string[] = [];
    let inline = "";
    const flush = () => {
      if (inline.trim()) paragraphs.push(inline);
      inline = "";
    };
    for (const child of node.children) {
      if (child.kind === "element" && BLOCKS.has(child.tag)) {
        flush();
        paragraphs.push(textFor(child, depth));
      } else {
        inline += textFor(child, depth);
      }
    }
    flush();
    return paragraphs.join("\n\n").split("\n").map(line => line ? `> ${line}` : ">").join("\n");
  }
  if (node.tag === "ul" || node.tag === "ol") {
    let index = node.start ?? 1;
    return node.children.filter(child => child.kind === "element" && child.tag === "li").map(child => {
      const marker = node.tag === "ol" ? `${index++}.` : "•";
      if (child.kind !== "element") return fail();
      let line = "";
      let previousBlock = false;
      for (const content of child.children) {
        const block = content.kind === "element" && BLOCKS.has(content.tag);
        if (content.kind === "element" && (content.tag === "ul" || content.tag === "ol")) {
          line = line.trimEnd() + "\n" + textFor(content, depth + 1);
        } else {
          if ((block || previousBlock) && line && !line.endsWith("\n")) line += "\n";
          line += textFor(content, depth);
        }
        previousBlock = block;
      }
      return `${"  ".repeat(depth)}${marker} ${line.trim()}`;
    }).join("\n");
  }
  if (node.tag === "table" || node.tag === "thead" || node.tag === "tbody" || node.tag === "tfoot") {
    return node.children.map(child => textFor(child, depth)).filter(Boolean).join("\n");
  }
  if (node.tag === "tr") return node.children.map(child => textFor(child, depth).trim()).join("\t");
  if (node.tag === "td" || node.tag === "th") {
    let text = "";
    let previousBlock = false;
    for (const child of node.children) {
      const block = child.kind === "element" && BLOCKS.has(child.tag);
      if (text && (block || previousBlock)) text += "\n";
      text += textFor(child, depth);
      previousBlock = block;
    }
    return text;
  }
  const text = node.children.map(child => textFor(child, depth)).join("");
  if (node.tag === "a" && node.href && text !== node.href) return `${text} (${node.href})`;
  return text;
}

/** Read the original range, not browser-computed markup, so partial inline selections retain their ancestors. */
export function serializeAssistantProseRange(root: HTMLElement, range: Range): AssistantProseClipboard | null {
  try {
    if (range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    if (parent(range.startContainer)?.closest(EDITABLE) || parent(range.endContainer)?.closest(EDITABLE)) return null;
    for (let ancestor: Element | null = root; ancestor; ancestor = ancestor.parentElement) {
      const style = ancestor.ownerDocument.defaultView?.getComputedStyle(ancestor);
      if (ancestor.hasAttribute("hidden") || ancestor.getAttribute("aria-hidden") === "true" || style?.display === "none" || style?.visibility === "hidden") return null;
    }
    for (const node of root.querySelectorAll(ATOMIC)) if (range.intersectsNode(node)) return null;
    for (const table of root.querySelectorAll("table")) {
      if (range.intersectsNode(table) && !coversContents(range, table)) return null;
    }
    let visited = 0;
    const walk = (node: Node, literal = false): Content[] => {
      if (++visited > 10_000) return fail();
      if (!range.intersectsNode(node)) return [];
      if (node instanceof Text) {
        const from = node === range.startContainer ? range.startOffset : 0;
        const to = node === range.endContainer ? range.endOffset : node.length;
        const value = node.data.slice(from, to);
        return value ? [{ kind: "text", value: literal ? value : value.replace(/[\t\r\n\f ]+/g, " ") }] : [];
      }
      if (!(node instanceof Element)) return node.nodeType === Node.COMMENT_NODE ? [] : fail();
      // Favicons are decorations. Content images and other unsupported nodes use native copy instead.
      if (node.tagName === "IMG" && node.getAttribute("aria-hidden") === "true" && node.getAttribute("alt") === "" && node.closest("a")) return [];
      if (node.matches('svg[data-github-reference-glyph][aria-hidden="true"]') && node.parentElement?.matches("a[data-openwork-link-href]")) return [];
      if (node.matches(ATOMIC) || node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return fail();
      const style = node.ownerDocument.defaultView?.getComputedStyle(node);
      if (style?.display === "none" || style?.visibility === "hidden") return fail();
      // Ignore the generated toolbar around a code block, never its prose or source code.
      if (node.matches("div[data-openwork-code-block]")) {
        const pre = node.querySelector("pre");
        if (!pre || !range.intersectsNode(pre)) return fail();
        return walk(pre, true);
      }
      const sourceTag = node.tagName.toLowerCase();
      const tag = sourceTag === "del" ? "s" : sourceTag === "mark" && node.getAttribute("data-search-highlight") === "true" ? "span" : sourceTag;
      if (node.matches("button[data-openwork-quote-copy]") && node.parentElement?.matches("blockquote[data-openwork-quote]")) return [];
      // Only the renderer's paired file-chip affordance and its icon are decorations.
      if (node.matches("button[data-openwork-link-chevron]")) {
        const link = node.parentElement?.querySelector("a[data-openwork-link-href]");
        if (link?.getAttribute("data-openwork-link-href") === node.getAttribute("data-openwork-link-chevron")) return [];
      }
      if (sourceTag === "svg") {
        const link = node.closest("a[data-openwork-link-href]");
        if (link && !hrefFor(link)) return [];
      }
      if (tag !== "div" && tag !== "span" && !isTag(tag)) return fail();
      if (node.matches(EDITABLE)) return fail();
      if ((tag === "td" || tag === "th") && (node.hasAttribute("colspan") || node.hasAttribute("rowspan"))) return fail();
      if (tag === "li" && node.hasAttribute("value")) return fail();
      if (tag === "ol" && (node.hasAttribute("reversed") || (node.hasAttribute("type") && node.getAttribute("type") !== "1"))) return fail();
      const parts = [...node.childNodes].map(source => ({ source, content: walk(source, literal || tag === "pre" || tag === "code") }));
      const children = parts.flatMap(part => part.content);
      if (tag === "div") {
        const content = children.filter(meaningful);
        if (!content.length) return [];
        // Renderer wrappers around blocks are transparent; text-bearing divs are blocks themselves.
        if (content.every(isInline)) return [element("p", children)];
        if (content.every(child => child.kind === "element" && BLOCKS.has(child.tag))) return children;
        return fail();
      }
      if (tag === "span") {
        if (!children.every(isInline)) return fail();
        return children;
      }
      if (!isTag(tag)) return fail();
      if (tag !== "br" && tag !== "hr" && !children.length) return [];
      validateChildren(tag, children);
      // A descendant-only selection cannot safely invent an empty parent item/marker.
      if (tag === "li" && children.filter(meaningful).every(child => child.kind === "element" && (child.tag === "ul" || child.tag === "ol"))) return fail();
      if (tag === "pre") {
        if (!children.every(child => isInline(child))) return fail();
        return [element("pre", [element("code", [{ kind: "text", value: codeText(children) }])])];
      }
      const result = element(tag, children);
      if (result.kind !== "element") return fail();
      if (tag === "a") {
        const file = filePathFor(node);
        if (file) {
          const path = element("code", [{ kind: "text", value: file.literal }]);
          const label = codeText(children);
          if (label === file.literal || label === file.name) return [path];
          return [...children, { kind: "text", value: " (" }, path, { kind: "text", value: ")" }];
        }
        result.href = hrefFor(node);
        if (!result.href) return children;
      }
      if (tag === "ol") {
        const declared = node.getAttribute("start") ?? "1";
        if (!/^-?\d+$/.test(declared)) return fail();
        const sourceItems = [...node.children].filter(child => child.tagName === "LI");
        const first = parts.find(part => part.source instanceof Element && part.source.tagName === "LI" && part.content.length > 0)?.source;
        const selectedIndex = sourceItems.findIndex(item => item === first);
        result.start = Number(declared) + Math.max(0, selectedIndex);
        if (!Number.isSafeInteger(result.start)) return fail();
      }
      return [result];
    };
    const selected = [...root.childNodes].flatMap(node => walk(node));
    const blocks: Content[] = [];
    let inline: Content[] = [];
    const flush = () => {
      if (inline.some(node => textFor(node).trim())) blocks.push(element("p", inline));
      inline = [];
    };
    for (const node of selected) {
      if (node.kind === "element" && BLOCKS.has(node.tag)) {
        if (node.tag === "li") return fail();
        flush(); blocks.push(node);
      } else {
        if (!isInline(node)) return fail();
        inline.push(node);
      }
    }
    flush();
    const text = blocks.map(node => textFor(node)).join("\n\n");
    if (!text.trim() || text.length > 1_000_000) return null;
    return { html: blocks.map(htmlFor).join(""), text };
  } catch {
    return null;
  }
}

/** Shared assembly for selected-copy and whole-message actions; not another converter. */
export function joinAssistantProseClipboard(pieces: readonly AssistantProseClipboard[]): AssistantProseClipboard | null {
  if (!pieces.length) return null;
  const text = pieces.map(piece => piece.text).join("\n\n");
  return text.length > 1_000_000 ? null : { html: pieces.map(piece => piece.html).join(SEPARATOR), text };
}

/** One message may interleave prose and activity. Only marked prose contributes. */
export function serializeAssistantMessageRange(root: HTMLElement, range: Range): AssistantProseClipboard | null {
  // Only React-owned direct children are provenance. Raw Markdown/tool HTML may forge attributes deeper down.
  const groups = [...root.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute("data-assistant-reply-prose"));
  return serializeAssistantProseGroupsRange(root, range, groups);
}

/** A reply may span physical/split messages; callers supply trusted React refs, not a selector. */
export function serializeAssistantProseGroupsRange(root: HTMLElement, range: Range, prose: readonly HTMLElement[]): AssistantProseClipboard | null {
  try {
    if (range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const groups = [...prose].sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    if (groups.some(group => !root.contains(group))) return null;
    const inProse = (node: Node) => node === root || groups.some(group => group.contains(node));
    // A selection starting/ending in tool UI is still native. Activity between prose endpoints is omitted.
    if (!inProse(range.startContainer) || !inProse(range.endContainer)) return null;
    const pieces: AssistantProseClipboard[] = [];
    for (const group of groups) {
      if (!range.intersectsNode(group)) continue;
      const clipped = group.ownerDocument.createRange();
      clipped.selectNodeContents(group);
      if (range.compareBoundaryPoints(Range.START_TO_START, clipped) > 0) clipped.setStart(range.startContainer, range.startOffset);
      if (range.compareBoundaryPoints(Range.END_TO_END, clipped) < 0) clipped.setEnd(range.endContainer, range.endOffset);
      if (clipped.collapsed) continue;
      const piece = serializeAssistantProseRange(group, clipped);
      if (!piece) return null;
      pieces.push(piece);
    }
    return joinAssistantProseClipboard(pieces);
  } catch { return null; }
}

type ProseCopyEvent = {
  clipboardData: { setData: (format: string, data: string) => void } | null;
  defaultPrevented: boolean;
  target: EventTarget | null;
  preventDefault: () => void;
};

/** No cancellation until both complete formats have been built and written. */
export function copyAssistantProseSelection(event: ProseCopyEvent, root: HTMLElement, enabled: boolean, grouped = false, proseGroups?: readonly HTMLElement[]): boolean {
  if (!enabled || event.defaultPrevented || !event.clipboardData) return false;
  try {
    if (event.target instanceof Element && event.target.closest(EDITABLE)) return false;
    const selection = root.ownerDocument.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    const data = proseGroups ? serializeAssistantProseGroupsRange(root, range, proseGroups)
      : (grouped ? serializeAssistantMessageRange : serializeAssistantProseRange)(root, range);
    if (!data) return false;
    event.clipboardData.setData("text/html", data.html);
    event.clipboardData.setData("text/plain", data.text);
    event.preventDefault();
    return true;
  } catch {
    return false;
  }
}
