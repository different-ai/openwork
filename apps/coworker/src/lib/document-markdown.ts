/**
 * Documents are Markdown designed for reading rather than chatting. This is the
 * pure half of that rendering: headings get stable ids (and a quiet table of
 * contents when there are three or more `##`), tables and task lists render,
 * code blocks come out as separate blocks so the view can give them a Copy
 * control, `> **Note**` quotes become callouts, images load only from the
 * coworker's own home, `doc:<id>` links open another document, and raw HTML is
 * shown as text. Sanitization is injected so the rules are unit-tested in Node
 * and applied with DOMPurify in the app.
 */
import { Marked, type Token, type Tokens } from "marked";

export type DocumentTocEntry = { id: string; text: string };
export type DocumentBlock = { kind: "html"; html: string } | { kind: "code"; lang: string; text: string; html: string };
export type RenderedDocument = { blocks: DocumentBlock[]; toc: DocumentTocEntry[] };

const CALLOUT_KINDS = new Map<string, string>([
  ["note", "note"],
  ["tip", "tip"],
  ["important", "important"],
  ["warning", "warning"],
  ["caution", "warning"],
]);
/** Three or more `##` sections earn the table of contents. */
export const TOC_MIN_SECTIONS = 3;

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function headingSlug(text: string): string {
  const stem = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return stem || "section";
}

function plainText(tokens: Token[] | undefined): string {
  return (tokens ?? []).map((token) => {
    if ("tokens" in token && Array.isArray(token.tokens) && token.tokens.length > 0) return plainText(token.tokens);
    return "text" in token && typeof token.text === "string" ? token.text : "";
  }).join("");
}

/** `workspace/chart.png` inside the coworker home → a `file://` URL; anything else is refused. */
export function workspaceImageUrl(href: string, coworkerPath: string): string | null {
  const trimmed = href.trim();
  if (!coworkerPath || !trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\")) return null;
  const segments = trimmed.replace(/\\/g, "/").split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) return null;
  const base = coworkerPath.replace(/\\/g, "/").replace(/\/+$/, "");
  return `file://${encodeURI(`${base}/${segments.join("/")}`)}`;
}

function calloutKind(tokens: Token[]): string {
  const first = tokens[0];
  if (!first || first.type !== "paragraph") return "";
  const lead = first.tokens?.[0];
  if (!lead || lead.type !== "strong") return "";
  return CALLOUT_KINDS.get(plainText(lead.tokens).trim().replace(/:$/, "").toLowerCase()) ?? "";
}

/**
 * A fresh parser per render: heading ids and image resolution depend on the
 * document, and the running heading counter must match between the table of
 * contents and the rendered blocks.
 */
function documentParser(coworkerPath: string, ids: string[]): Marked {
  let headingIndex = 0;
  const instance = new Marked({ gfm: true, breaks: false, async: false });
  instance.use({
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const id = ids[headingIndex] ?? `doc-${headingSlug(plainText(tokens))}`;
        headingIndex += 1;
        return `<h${depth} id="${escapeHtml(id)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
      link({ href, title, tokens }: Tokens.Link) {
        const label = this.parser.parseInline(tokens);
        if (/^doc:/i.test(href)) {
          const id = href.slice(4).trim();
          return `<a href="${escapeHtml(href)}" data-doc="${escapeHtml(id)}" class="doc-link">${label}</a>`;
        }
        if (href.startsWith("#")) return `<a href="${escapeHtml(href)}">${label}</a>`;
        if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) return label;
        return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ""}>${label}</a>`;
      },
      image({ href, title, text }: Tokens.Image) {
        const url = workspaceImageUrl(href, coworkerPath);
        if (!url) return `<span class="doc-image-missing">${escapeHtml(text || href)}</span>`;
        return `<img src="${url}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ""} loading="lazy">`;
      },
      blockquote({ tokens }: Tokens.Blockquote) {
        const kind = calloutKind(tokens);
        const body = this.parser.parse(tokens);
        return kind ? `<blockquote class="doc-callout" data-callout="${kind}">\n${body}</blockquote>\n` : `<blockquote>\n${body}</blockquote>\n`;
      },
      // Raw HTML written into a document is shown, never interpreted.
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(text);
      },
    },
  });
  return instance;
}

/**
 * Lex once; ids for every heading in document order, the `##` table of
 * contents, and the blocks to render (code blocks on their own).
 */
export function renderDocument(text: string, coworkerPath = "", sanitize: (html: string) => string = (html) => html): RenderedDocument {
  const tokens = documentParser(coworkerPath, []).lexer(text);
  const ids: string[] = [];
  const seen = new Map<string, number>();
  const toc: DocumentTocEntry[] = [];
  for (const token of tokens) {
    if (token.type !== "heading") continue;
    const label = plainText(token.tokens).trim();
    const base = headingSlug(label);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const id = count === 0 ? `doc-${base}` : `doc-${base}-${count + 1}`;
    ids.push(id);
    if (token.depth === 2) toc.push({ id, text: label });
  }
  const renderer = documentParser(coworkerPath, ids);
  const blocks: DocumentBlock[] = [];
  let pending: Token[] = [];
  const render = (list: Token[]): string => {
    const html = renderer.parser(list);
    return sanitize(typeof html === "string" ? html : "");
  };
  const flush = () => {
    if (pending.length === 0) return;
    blocks.push({ kind: "html", html: render(pending) });
    pending = [];
  };
  for (const token of tokens) {
    if (token.type === "code") {
      flush();
      blocks.push({ kind: "code", lang: token.lang?.trim() ?? "", text: token.text, html: render([token]) });
      continue;
    }
    pending.push(token);
  }
  flush();
  return { blocks, toc: toc.length >= TOC_MIN_SECTIONS ? toc : [] };
}
