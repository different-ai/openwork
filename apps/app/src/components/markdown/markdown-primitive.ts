import DOMPurify from "dompurify";
import emojiKeywords from "emojilib";
import { Marked, type Tokens } from "marked";
import { markedEmoji } from "marked-emoji";
import markedShiki from "marked-shiki";
import {
  transformerMetaHighlight,
  transformerMetaWordHighlight,
  transformerNotationDiff,
  transformerNotationErrorLevel,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
} from "@shikijs/transformers";
import { bundledLanguages, codeToHtml } from "shiki";

import { faviconUrlForHref } from "@/lib/favicon";

import { markdownMath } from "./markdown-math";

export type MarkdownPresentation = "chat" | "surface";
type RawHtmlMode = "passthrough" | "shiki-only";
type ShikiThemeConfig =
  | { kind: "single"; theme: string }
  | { kind: "dual"; light: string; dark: string };

type MarkdownProfile = {
  rawHtmlMode: RawHtmlMode;
  headingClassName: (depth: number) => string;
  listClassName: (ordered: boolean) => string;
  blockquoteClassName: string;
  codeBlockHtml: (text: string, lang: string | undefined) => string;
  codeSpanClassName: string;
  linkPresentation: "chat" | "simple";
  imagePresentation: "chat" | "simple";
  tableHeaderClassName: string;
  tableCellClassName: string;
  shikiContainer: string;
  shikiTheme: ShikiThemeConfig;
};

const MARKDOWN_IMAGE_PREVIEW_MAX_HEIGHT = 160;
const MARKDOWN_IMAGE_PREVIEW_MAX_WIDTH = 280;
const CODE_COPY_ICON = `<svg data-openwork-code-copy-icon="" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
const CODE_COPIED_ICON = `<svg data-openwork-code-copy-check-icon="" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5" aria-hidden="true" hidden><path d="M20 6 9 17l-5-5"/></svg>`;

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
      if (!aliases[name]) {
        aliases[name] = emoji;
      }
    }
  }

  return aliases;
}

const emojiAliases = createEmojiAliases();

function codeCopyButton() {
  return `<button type="button" data-openwork-code-copy="" class="absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/70 bg-background/95 text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Copy code block" title="Copy code block">${CODE_COPY_ICON}${CODE_COPIED_ICON}<span data-openwork-code-copy-label="" class="sr-only" aria-live="polite">Copy code block</span></button>`;
}

function chatCodeBlockContainer(html: string, shiki: boolean) {
  const shikiAttribute = shiki ? ` data-openwork-shiki="true"` : "";

  return `<div data-openwork-code-block=""${shikiAttribute} class="relative my-4 overflow-hidden rounded-[18px] border border-border/70 bg-gray-2/60 font-mono text-xs leading-6 text-foreground">${codeCopyButton()}${html}</div>`;
}

function chatCodeBlockHtml(text: string, lang: string | undefined) {
  return chatCodeBlockContainer(
    `<pre class="overflow-x-auto px-4 pb-3 pt-11"><code${codeLanguageClass(lang)}>${escapeHtml(text)}</code></pre>`,
    false,
  );
}

function surfaceCodeBlockHtml(text: string, lang: string | undefined) {
  return `<pre class="my-4 overflow-x-auto rounded-[18px] border border-dls-border/70 bg-gray-1/80 px-4 py-3 text-xs leading-6 text-muted-foreground"><code${codeLanguageClass(lang)}>${escapeHtml(text)}</code></pre>`;
}

function parseShikiLanguage(lang: string) {
  const normalized = lang.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return normalized in bundledLanguages ? normalized : "text";
}

export function hasFencedCodeBlock(text: string) {
  return /(^|\n)```/.test(text);
}

export function syncMarkdownImagePreviews(root: HTMLElement) {
  const previews = root.querySelectorAll("[data-openwork-image-preview]");

  for (const preview of previews) {
    if (!(preview instanceof HTMLElement)) continue;

    const image = preview.querySelector("img");
    if (!(image instanceof HTMLImageElement)) continue;

    image.style.maxHeight = `${MARKDOWN_IMAGE_PREVIEW_MAX_HEIGHT}px`;
    image.style.maxWidth = `${MARKDOWN_IMAGE_PREVIEW_MAX_WIDTH}px`;
  }
}

export function setCodeCopyButtonState(button: HTMLButtonElement, copied: boolean) {
  const label = button.querySelector("[data-openwork-code-copy-label]");
  if (label) label.textContent = copied ? "Code block copied" : "Copy code block";

  button.querySelector("[data-openwork-code-copy-icon]")?.toggleAttribute("hidden", copied);
  button.querySelector("[data-openwork-code-copy-check-icon]")?.toggleAttribute("hidden", !copied);

  button.title = copied ? "Copied" : "Copy code block";
  button.setAttribute("aria-label", copied ? "Code block copied" : "Copy code block");
}

function sanitizeMarkdownHtml(value: string) {
  if (typeof DOMPurify.sanitize !== "function") {
    return value;
  }

  return DOMPurify.sanitize(value, {
    // KaTeX wraps its MathML branch in <semantics>/<annotation>, neither of which is
    // in DOMPurify's default MathML allowlist. Without these the accessible MathML
    // (and copy-as-TeX) half of every formula is stripped.
    ADD_TAGS: ["annotation", "semantics"],
    ADD_ATTR: [
      "checked",
      "class",
      "data-openwork-math-error",
      "data-openwork-code-block",
      "data-openwork-code-copy",
      "data-openwork-code-copy-check-icon",
      "data-openwork-code-copy-icon",
      "data-openwork-code-copy-label",
      "aria-label",
      "data-openwork-image-preview",
      "data-openwork-link-href",
      "data-openwork-link-chevron",
      "data-openwork-shiki",
      "decoding",
      "disabled",
      "hidden",
      "loading",
      "rel",
      "start",
      "style",
      "target",
    ],
  });
}

function markdownProfileForPresentation(presentation: MarkdownPresentation): MarkdownProfile {
  if (presentation === "surface") {
    return {
      rawHtmlMode: "shiki-only",
      headingClassName: (depth) => depth === 1
        ? "my-5 text-xl font-semibold"
        : depth === 2
          ? "my-4 text-lg font-semibold"
          : "my-3 text-base font-semibold",
      listClassName: (ordered) => ordered ? "my-3 list-decimal pl-6" : "my-3 list-disc pl-6",
      blockquoteClassName: "my-4 rounded-r-lg border-l border-dls-border bg-dls-hover/40 pl-4 italic text-muted-foreground",
      codeBlockHtml: surfaceCodeBlockHtml,
      codeSpanClassName: "rounded-md bg-gray-2/70 px-1.5 py-0.5 font-mono text-sm text-foreground",
      linkPresentation: "simple",
      imagePresentation: "simple",
      tableHeaderClassName: "border border-dls-border bg-dls-hover p-2 text-left",
      tableCellClassName: "border border-dls-border p-2 align-top",
      shikiContainer: `<div data-openwork-shiki="true" class="my-4 overflow-x-auto rounded-[18px] border border-dls-border/70 bg-gray-1/80 p-4 text-xs leading-6">%s</div>`,
      shikiTheme: { kind: "single", theme: "github-light" },
    };
  }

  return {
    rawHtmlMode: "passthrough",
    headingClassName: (depth) => depth === 1
      ? "font-semibold my-5 text-xl"
      : depth === 2
        ? "font-semibold my-4 text-lg"
        : "font-semibold my-3 text-base",
    listClassName: (ordered) => ordered ? "my-3 pl-6 list-decimal" : "my-3 pl-6 list-disc",
    blockquoteClassName: "my-4 rounded-r-lg border-l border-border bg-muted/40 pl-4 italic text-muted-foreground",
    codeBlockHtml: chatCodeBlockHtml,
    codeSpanClassName: "rounded-md bg-gray-2/70 px-1.5 py-0.5 font-mono text-sm text-foreground",
    linkPresentation: "chat",
    imagePresentation: "chat",
    tableHeaderClassName: "border border-border p-2 bg-muted text-left",
    tableCellClassName: "border border-border p-2 align-top",
    shikiContainer: chatCodeBlockContainer(`<div class="overflow-x-auto px-4 pb-3 pt-11">%s</div>`, true),
    shikiTheme: { kind: "dual", light: "github-light", dark: "github-dark" },
  };
}

function renderLink(profile: MarkdownProfile, href: string, title: string | null | undefined, text: string) {
  const safe = escapeAttribute(safeHref(href));
  const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";

  if (profile.linkPresentation === "chat") {
    const originalHref = escapeAttribute(href);
    const isFilePath = !/^(https?|wss?|ftp|mailto|tel|file):/i.test(href);

    if (isFilePath) {
      const fileIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/></svg>`;
      const chevron = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><path d="m6 9 6 6 6-6"/></svg>`;

      return `<span class="inline-flex items-stretch overflow-hidden rounded-md border border-border/60 bg-muted/40 text-xs font-medium text-foreground align-middle"><a href="${safe}" data-openwork-link-href="${originalHref}"${titleAttr} target="_blank" rel="noreferrer noopener" class="inline-flex items-center gap-1 px-1.5 py-0.5 no-underline transition-colors hover:bg-muted">${fileIcon}${text}</a><button type="button" data-openwork-link-chevron="${originalHref}" class="inline-flex items-center border-l border-border/60 px-1 transition-colors hover:bg-muted" aria-label="Open with">${chevron}</button></span>`;
    }

    const favicon = faviconUrlForHref(href);
    const faviconHtml = favicon
      ? `<img src="${escapeAttribute(favicon)}" alt="" aria-hidden="true" loading="lazy" decoding="async" class="me-1 inline-block size-3.5 rounded-[3px] align-[-2px]" />`
      : "";

    return `<a href="${safe}" data-openwork-link-href="${originalHref}"${titleAttr} target="_blank" rel="noreferrer noopener" class="text-indigo-10 no-underline transition-colors hover:text-indigo-8">${faviconHtml}${text}</a>`;
  }

  return `<a href="${safe}"${titleAttr} target="_blank" rel="noreferrer noopener" class="text-indigo-10 no-underline transition-colors hover:text-indigo-8">${text}</a>`;
}

function renderImage(profile: MarkdownProfile, href: string, title: string | null | undefined, text: string) {
  const safe = escapeAttribute(safeHref(href));
  const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";

  if (profile.imagePresentation === "chat") {
    return `<button type="button" data-openwork-image-preview="" class="my-4 inline-block max-w-full cursor-zoom-in align-top text-left transition-opacity hover:opacity-90" aria-label="Expand ${escapeAttribute(text)}"><img src="${safe}" alt="${escapeAttribute(text)}"${titleAttr} loading="lazy" decoding="async" class="block h-auto w-auto rounded-lg border border-border/70 object-contain" style="max-height: ${MARKDOWN_IMAGE_PREVIEW_MAX_HEIGHT}px; max-width: ${MARKDOWN_IMAGE_PREVIEW_MAX_WIDTH}px"></button>`;
  }

  return `<img src="${safe}" alt="${escapeAttribute(text)}"${titleAttr} loading="lazy" decoding="async" class="my-4 max-w-full rounded-[18px] border border-dls-border/70">`;
}

function createMarkedOptions(profile: MarkdownProfile, isAsync: boolean) {
  return {
    async: isAsync,
    breaks: false,
    gfm: true,
    pedantic: false,
    silent: true,
    renderer: {
      html({ text }) {
        return profile.rawHtmlMode === "shiki-only" && !text.includes('data-openwork-shiki="true"') ? "" : text;
      },
      paragraph({ tokens }) {
        return `<p class="my-3 leading-relaxed">${this.parser.parseInline(tokens)}</p>`;
      },
      heading({ tokens, depth }) {
        return `<h${depth} class="${profile.headingClassName(depth)}">${this.parser.parseInline(tokens)}</h${depth}>`;
      },
      list(token) {
        const tag = token.ordered ? "ol" : "ul";
        const start = token.ordered && typeof token.start === "number" && token.start !== 1
          ? ` start="${token.start}"`
          : "";
        return `<${tag}${start} class="${profile.listClassName(token.ordered)}">${token.items.map((item) => this.listitem(item)).join("")}</${tag}>`;
      },
      listitem(item) {
        const checkbox = item.task
          ? `<input disabled="" type="checkbox"${item.checked ? " checked=\"\"" : ""}> `
          : "";

        return `<li class="my-1">${checkbox}${this.parser.parse(item.tokens)}</li>`;
      },
      blockquote({ tokens }) {
        return `<blockquote class="${profile.blockquoteClassName}">${this.parser.parse(tokens)}</blockquote>`;
      },
      code({ text, lang }) {
        return profile.codeBlockHtml(text, lang);
      },
      codespan({ text }) {
        return `<code class="${profile.codeSpanClassName}">${escapeHtml(text)}</code>`;
      },
      del({ raw, tokens }) {
        if (!raw.startsWith("~~")) {
          return escapeHtml(raw);
        }

        return `<del>${this.parser.parseInline(tokens)}</del>`;
      },
      link({ href, title, tokens }) {
        return renderLink(profile, href, title, this.parser.parseInline(tokens));
      },
      image({ href, title, text }) {
        return renderImage(profile, href, title, text);
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
        const className = header ? profile.tableHeaderClassName : profile.tableCellClassName;

        return `<${tag}${alignAttribute(align)} class="${className}">${this.parser.parseInline(tokens)}</${tag}>`;
      },
      hr() {
        return `<hr class="my-6 border-none h-px bg-gray-4">`;
      },
    },
  } satisfies ConstructorParameters<typeof Marked<string, string>>[0];
}

function markdownTransformers() {
  return [
    transformerNotationDiff({ matchAlgorithm: "v3" }),
    transformerNotationHighlight({ matchAlgorithm: "v3" }),
    transformerNotationWordHighlight({ matchAlgorithm: "v3" }),
    transformerNotationFocus({ matchAlgorithm: "v3" }),
    transformerNotationErrorLevel({ matchAlgorithm: "v3" }),
    transformerMetaHighlight(),
    transformerMetaWordHighlight(),
  ];
}

function createMarkdownParsers(presentation: MarkdownPresentation) {
  const profile = markdownProfileForPresentation(presentation);
  const markdownParser = new Marked<string, string>(createMarkedOptions(profile, false)).use(
    markedEmoji({
      emojis: emojiAliases,
      renderer: (token) => escapeHtml(token.emoji),
    }),
    markdownMath(),
  );
  // Math must be registered on both parsers, otherwise formulas would flicker away
  // when a message containing a fenced code block upgrades to the Shiki render.
  const highlightedMarkdownParser = new Marked<string, string>(createMarkedOptions(profile, true)).use(
    markedEmoji({
      emojis: emojiAliases,
      renderer: (token) => escapeHtml(token.emoji),
    }),
    markdownMath(),
    markedShiki({
      async highlight(code, lang, props) {
        const language = parseShikiLanguage(lang);

        if (profile.shikiTheme.kind === "dual") {
          return codeToHtml(code, {
            lang: language,
            meta: { __raw: props.join(" ") },
            themes: {
              light: profile.shikiTheme.light,
              dark: profile.shikiTheme.dark,
            },
            transformers: markdownTransformers(),
          });
        }

        return codeToHtml(code, {
          lang: language,
          meta: { __raw: props.join(" ") },
          theme: profile.shikiTheme.theme,
          transformers: markdownTransformers(),
        });
      },
      container: profile.shikiContainer,
    }),
  );

  return { markdownParser, highlightedMarkdownParser };
}

const chatParsers = createMarkdownParsers("chat");
const surfaceParsers = createMarkdownParsers("surface");

function parsersForPresentation(presentation: MarkdownPresentation) {
  return presentation === "surface" ? surfaceParsers : chatParsers;
}

export function renderMarkdownHtml(text: string, presentation: MarkdownPresentation = "chat") {
  if (!text.trim()) {
    return "";
  }

  const { markdownParser } = parsersForPresentation(presentation);
  return sanitizeMarkdownHtml(markdownParser.parse(text, { async: false }));
}

export async function renderHighlightedMarkdownHtml(text: string, presentation: MarkdownPresentation = "chat") {
  const { highlightedMarkdownParser } = parsersForPresentation(presentation);
  const html = await highlightedMarkdownParser.parse(text, { async: true });
  return sanitizeMarkdownHtml(html);
}
