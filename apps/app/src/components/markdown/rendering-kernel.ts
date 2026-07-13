import { Marked, type Tokens } from "marked";
import { markedEmoji } from "marked-emoji";
import markedShiki from "marked-shiki";
import emojiKeywords from "emojilib";

export type MarkdownPresentationVariant = "conversation" | "document-preview";

export type MarkdownHighlightRequest = {
  code: string;
  language: string;
  meta: readonly string[];
};

export type MarkdownRenderingPorts = {
  sanitizeHtml: (html: string) => string;
  isHighlightLanguageSupported: (language: string) => boolean;
  highlightCode: (request: MarkdownHighlightRequest) => Promise<string>;
};

export type MarkdownRenderingKernel = {
  hasFencedCodeBlock: (text: string) => boolean;
  renderSync: (text: string, variant: MarkdownPresentationVariant) => string;
  renderHighlighted: (text: string, variant: MarkdownPresentationVariant) => Promise<string>;
};

const MARKDOWN_IMAGE_PREVIEW_MAX_HEIGHT = 100;

const PRESENTATION_STYLES = {
  conversation: {
    heading: {
      1: "font-semibold my-5 text-xl",
      2: "font-semibold my-4 text-lg",
      rest: "font-semibold my-3 text-base",
    },
    orderedList: "my-3 pl-6 list-decimal",
    unorderedList: "my-3 pl-6 list-disc",
    blockquote: "my-4 rounded-r-lg border-l border-border bg-muted/40 pl-4 italic text-muted-foreground",
    code: "my-4 overflow-x-auto rounded-[18px] border border-border/70 bg-gray-1/80 px-4 py-3 text-xs leading-6 text-muted-foreground",
    tableHeader: "border border-border p-2 bg-muted text-left",
    tableCell: "border border-border p-2 align-top",
    highlightedCode: "my-4 overflow-x-auto rounded-lg border border-border/70 bg-gray-1/80 p-4 text-xs leading-6",
  },
  "document-preview": {
    heading: {
      1: "my-5 text-xl font-semibold",
      2: "my-4 text-lg font-semibold",
      rest: "my-3 text-base font-semibold",
    },
    orderedList: "my-3 list-decimal pl-6",
    unorderedList: "my-3 list-disc pl-6",
    blockquote: "my-4 rounded-r-lg border-l border-dls-border bg-dls-hover/40 pl-4 italic text-muted-foreground",
    code: "my-4 overflow-x-auto rounded-[18px] border border-dls-border/70 bg-gray-1/80 px-4 py-3 text-xs leading-6 text-muted-foreground",
    tableHeader: "border border-dls-border bg-dls-hover p-2 text-left",
    tableCell: "border border-dls-border p-2 align-top",
    highlightedCode: "my-4 overflow-x-auto rounded-[18px] border border-dls-border/70 bg-gray-1/80 p-4 text-xs leading-6",
  },
} satisfies Record<MarkdownPresentationVariant, {
  heading: { 1: string; 2: string; rest: string };
  orderedList: string;
  unorderedList: string;
  blockquote: string;
  code: string;
  tableHeader: string;
  tableCell: string;
  highlightedCode: string;
}>;

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function safeHref(href: string) {
  const trimmed = href.trim();

  if (!trimmed) {
    return "#";
  }

  if (trimmed.startsWith("#") || trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);

    if (["http:", "https:", "mailto:"].includes(parsed.protocol)) {
      return trimmed;
    }
  } catch {
    return "#";
  }

  return "#";
}

function alignAttribute(align: Tokens.TableCell["align"]) {
  return align ? ` style="text-align: ${align}"` : "";
}

function codeLanguageClass(lang: string | undefined) {
  const normalized = lang?.trim().split(/\s+/)[0];

  return normalized ? ` class="language-${escapeAttribute(normalized)}"` : "";
}

function createEmojiAliases() {
  const aliases: Record<string, string> = {};

  for (const [emoji, names] of Object.entries(emojiKeywords)) {
    for (const name of names) {
      if (aliases[name] === undefined) {
        aliases[name] = emoji;
      }
    }
  }

  return aliases;
}

const emojiAliases = createEmojiAliases();

function normalizeHighlightLanguage(language: string, ports: MarkdownRenderingPorts) {
  const normalized = language.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

  return ports.isHighlightLanguageSupported(normalized) ? normalized : "text";
}

function hasFencedCodeBlock(text: string) {
  return /(^|\n)```/.test(text);
}

function headingClass(variant: MarkdownPresentationVariant, depth: number) {
  const styles = PRESENTATION_STYLES[variant].heading;

  if (depth === 1) return styles[1];
  if (depth === 2) return styles[2];
  return styles.rest;
}

function renderConversationLink(href: string, title: string | null | undefined, content: string) {
  const safe = escapeAttribute(safeHref(href));
  const originalHref = escapeAttribute(href);
  const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
  const isFilePath = !/^(https?|wss?|ftp|mailto|tel|file):/i.test(href);

  if (isFilePath) {
    const fileIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/></svg>`;
    const chevron = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><path d="m6 9 6 6 6-6"/></svg>`;

    return `<span class="inline-flex items-stretch overflow-hidden rounded-md border border-border/60 bg-muted/40 text-xs font-medium text-foreground align-middle"><a href="${safe}" data-openwork-link-href="${originalHref}"${titleAttr} target="_blank" rel="noreferrer noopener" class="inline-flex items-center gap-1 px-1.5 py-0.5 no-underline transition-colors hover:bg-muted">${fileIcon}${content}</a><button type="button" data-openwork-link-chevron="${originalHref}" class="inline-flex items-center border-l border-border/60 px-1 transition-colors hover:bg-muted" aria-label="Open with">${chevron}</button></span>`;
  }

  return `<a href="${safe}" data-openwork-link-href="${originalHref}"${titleAttr} target="_blank" rel="noreferrer noopener" class="text-indigo-10 underline underline-offset-2 transition-colors hover:text-indigo-8">${content}</a>`;
}

function renderDocumentPreviewLink(href: string, title: string | null | undefined, content: string) {
  const safe = escapeAttribute(safeHref(href));
  const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";

  return `<a href="${safe}"${titleAttr} target="_blank" rel="noreferrer noopener" class="text-indigo-10 underline underline-offset-2 transition-colors hover:text-indigo-8">${content}</a>`;
}

function renderConversationImage(href: string, title: string | null | undefined, text: string) {
  const safe = escapeAttribute(safeHref(href));
  const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";

  return `<span data-openwork-image-preview="collapsed" class="relative my-4 inline-block max-w-full overflow-hidden rounded-lg border border-border/70 align-top" style="max-height: ${MARKDOWN_IMAGE_PREVIEW_MAX_HEIGHT}px"><img src="${safe}" alt="${escapeAttribute(text)}"${titleAttr} loading="lazy" decoding="async" class="block h-auto max-w-full"><button type="button" data-openwork-image-toggle="" hidden class="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-background via-background/90 to-transparent pb-2 pt-8"><span data-openwork-image-toggle-label="" class="rounded-full border border-border bg-background/95 px-3 py-1 text-xs font-medium text-foreground shadow-sm">Show full image</span></button></span>`;
}

function renderDocumentPreviewImage(href: string, title: string | null | undefined, text: string) {
  const safe = escapeAttribute(safeHref(href));
  const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";

  return `<img src="${safe}" alt="${escapeAttribute(text)}"${titleAttr} loading="lazy" decoding="async" class="my-4 max-w-full rounded-[18px] border border-dls-border/70">`;
}

function createMarkedOptions(
  variant: MarkdownPresentationVariant,
  highlighted: boolean,
  isTrustedGeneratedHtml: (html: string) => boolean = () => false,
) {
  const styles = PRESENTATION_STYLES[variant];

  return {
    async: highlighted,
    breaks: false,
    gfm: true,
    pedantic: false,
    // Let async highlighter failures reject so renderHighlighted can preserve
    // the synchronous escaped-code fallback instead of rendering Marked's
    // internal error message as user content.
    silent: !highlighted,
    renderer: {
      html({ text }) {
        if (variant === "conversation") return text;
        return highlighted && isTrustedGeneratedHtml(text) ? text : "";
      },
      paragraph({ tokens }) {
        return `<p class="my-3 leading-relaxed">${this.parser.parseInline(tokens)}</p>`;
      },
      heading({ tokens, depth }) {
        return `<h${depth} class="${headingClass(variant, depth)}">${this.parser.parseInline(tokens)}</h${depth}>`;
      },
      list(token) {
        const tag = token.ordered ? "ol" : "ul";
        const className = token.ordered ? styles.orderedList : styles.unorderedList;
        const start = token.ordered && typeof token.start === "number" && token.start !== 1
          ? ` start="${token.start}"`
          : "";

        return `<${tag}${start} class="${className}">${token.items.map((item) => this.listitem(item)).join("")}</${tag}>`;
      },
      listitem(item) {
        const checkbox = item.task
          ? `<input disabled="" type="checkbox"${item.checked ? " checked=\"\"" : ""}> `
          : "";

        return `<li class="my-1">${checkbox}${this.parser.parse(item.tokens)}</li>`;
      },
      blockquote({ tokens }) {
        return `<blockquote class="${styles.blockquote}">${this.parser.parse(tokens)}</blockquote>`;
      },
      code({ text, lang }) {
        return `<pre class="${styles.code}"><code${codeLanguageClass(lang)}>${escapeHtml(text)}</code></pre>`;
      },
      codespan({ text }) {
        return `<code class="rounded-md bg-gray-2/70 px-1.5 py-0.5 font-mono text-sm text-foreground">${escapeHtml(text)}</code>`;
      },
      del({ raw, tokens }) {
        if (!raw.startsWith("~~")) {
          return escapeHtml(raw);
        }

        return `<del>${this.parser.parseInline(tokens)}</del>`;
      },
      link({ href, title, tokens }) {
        const content = this.parser.parseInline(tokens);

        return variant === "conversation"
          ? renderConversationLink(href, title, content)
          : renderDocumentPreviewLink(href, title, content);
      },
      image({ href, title, text }) {
        return variant === "conversation"
          ? renderConversationImage(href, title, text)
          : renderDocumentPreviewImage(href, title, text);
      },
      table(token) {
        const header = token.header.map((cell) => this.tablecell({ ...cell, header: true })).join("");
        const body = token.rows.map((row) => this.tablerow({ text: row.map((cell) => this.tablecell(cell)).join("") })).join("");

        return `<table class="my-4 w-full border-collapse"><thead>${this.tablerow({ text: header })}</thead><tbody>${body}</tbody></table>`;
      },
      tablerow({ text }) {
        return `<tr>${text}</tr>`;
      },
      tablecell({ tokens, header, align }) {
        const tag = header ? "th" : "td";
        const className = header ? styles.tableHeader : styles.tableCell;

        return `<${tag}${alignAttribute(align)} class="${className}">${this.parser.parseInline(tokens)}</${tag}>`;
      },
      hr() {
        return `<hr class="my-6 border-none h-px bg-gray-4">`;
      },
    },
  } satisfies ConstructorParameters<typeof Marked<string, string>>[0];
}

function emojiExtension() {
  return markedEmoji({
    emojis: emojiAliases,
    renderer: (token) => escapeHtml(token.emoji),
  });
}

function createSyncParser(variant: MarkdownPresentationVariant) {
  return new Marked<string, string>(createMarkedOptions(variant, false)).use(emojiExtension());
}

function createHighlightedParser(variant: MarkdownPresentationVariant, ports: MarkdownRenderingPorts) {
  const trustedGeneratedHtml = new Set<string>();
  const isTrustedGeneratedHtml = (html: string) => trustedGeneratedHtml.has(html.trimEnd());

  return new Marked<string, string>(createMarkedOptions(variant, true, isTrustedGeneratedHtml)).use(
    emojiExtension(),
    markedShiki({
      async highlight(code, language, meta) {
        const highlightedHtml = await ports.highlightCode({
          code,
          language: normalizeHighlightLanguage(language, ports),
          meta,
        });
        const generatedHtml = `<div data-openwork-shiki="true" class="${PRESENTATION_STYLES[variant].highlightedCode}">${highlightedHtml}</div>`;

        trustedGeneratedHtml.add(generatedHtml);
        return generatedHtml;
      },
    }),
  );
}

export function createMarkdownRenderingKernel(ports: MarkdownRenderingPorts): MarkdownRenderingKernel {
  const syncParsers = {
    conversation: createSyncParser("conversation"),
    "document-preview": createSyncParser("document-preview"),
  } satisfies Record<MarkdownPresentationVariant, Marked<string, string>>;
  const renderSync = (text: string, variant: MarkdownPresentationVariant) => {
    if (!text.trim()) return "";
    return ports.sanitizeHtml(syncParsers[variant].parse(text, { async: false }));
  };

  const renderHighlighted = async (text: string, variant: MarkdownPresentationVariant) => {
    if (!text.trim()) return "";

    try {
      // Keep the generated-HTML allowlist scoped to this parse. This lets the
      // document presentation reject user-authored raw HTML without trusting
      // a forgeable data attribute, while still accepting the exact Shiki
      // fragment produced through the injected highlighter port.
      const parser = createHighlightedParser(variant, ports);
      const html = await parser.parse(text, { async: true });
      const sanitizedHtml = ports.sanitizeHtml(html);

      return sanitizedHtml.trim() ? sanitizedHtml : renderSync(text, variant);
    } catch {
      return renderSync(text, variant);
    }
  };

  return Object.freeze({
    hasFencedCodeBlock,
    renderSync,
    renderHighlighted,
  });
}
