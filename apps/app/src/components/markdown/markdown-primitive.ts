import DOMPurify from "dompurify";
import emojiKeywords from "emojilib";
import { Marked, type MarkedExtension, type Token, type Tokens } from "marked";
import { markedEmoji } from "marked-emoji";
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
const CODE_WRAP_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5" aria-hidden="true"><path d="M3 6h18M3 12h15a3 3 0 1 1 0 6h-3"/><path d="m12 18-3 3 3 3"/></svg>`;
const INLINE_CODE_FILE_EXTENSIONS = new Set([
  "mp4", "webm", "mov", "m4v", "ogv",
  "astro", "bash", "c", "cc", "cpp", "cs", "css", "dart", "docx", "ex", "exs", "gif", "go", "graphql",
  "h", "hpp", "htm", "html", "java", "jpeg", "jpg", "js", "json", "jsonc", "jsx", "key", "kt", "kts",
  "lua", "markdown", "md", "mdx", "mmd", "mjs", "cjs", "odp", "ods", "pdf", "php", "png", "pot", "potx",
  "ppt", "pptm", "pptx", "prisma", "py", "rb", "rs", "scss", "sh", "sql", "svelte", "svg", "swift",
  "toml", "ts", "tsv", "tsx", "txt", "log", "vue", "webp", "xls", "xlsx", "xml", "yaml", "yml", "zig",
]);
const INLINE_CODE_LINE_SUFFIX = /(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/i;

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

export function inlineCodeArtifactPath(value: string): string | null {
  const trimmed = value.trim();
  const path = trimmed.replace(INLINE_CODE_LINE_SUFFIX, "");

  if (
    !path ||
    path.length > 500 ||
    /[\u0000-\u001f<>"'`|?*]/.test(path) ||
    /^(?:https?|wss?|ftp|mailto|tel|file):/i.test(path)
  ) {
    return null;
  }

  const normalized = path.replace(/[\\]+/g, "/");
  const withoutDrive = normalized.replace(/^[A-Za-z]:\//, "/");
  if (withoutDrive.slice(1).includes(":")) return null;

  const segments = withoutDrive.split("/").filter(Boolean);
  const filename = segments.at(-1);
  if (!filename || segments.some((segment) => segment === "." || segment === "..")) return null;

  const extensionIndex = filename.lastIndexOf(".");
  const extension = extensionIndex >= 0 ? filename.slice(extensionIndex + 1).toLowerCase() : "";
  return INLINE_CODE_FILE_EXTENSIONS.has(extension) ? path : null;
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

function codeWrapButton() {
  return `<button type="button" data-openwork-code-wrap="" class="absolute right-11 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/70 bg-background/95 text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Enable word wrap" aria-pressed="false" title="Enable word wrap">${CODE_WRAP_ICON}</button>`;
}

function chatCodeBlockContainer(html: string, shiki: boolean) {
  const shikiAttribute = shiki ? ` data-openwork-shiki="true"` : "";

  return `<div data-openwork-code-block=""${shikiAttribute} class="relative my-4 overflow-hidden rounded-[18px] border border-border/70 bg-gray-2/60 font-mono text-xs leading-6 text-foreground">${codeWrapButton()}${codeCopyButton()}${html}</div>`;
}

function chatCodeBlockHtml(text: string, lang: string | undefined) {
  return chatCodeBlockContainer(
    `<pre data-openwork-code-scroll="" class="overflow-x-auto px-4 pb-3 pt-11"><code${codeLanguageClass(lang)}>${escapeHtml(text)}</code></pre>`,
    false,
  );
}

function surfaceCodeBlockHtml(text: string, lang: string | undefined) {
  return `<pre class="my-4 overflow-x-auto rounded-[18px] border border-dls-border/70 bg-gray-1/80 px-4 py-3 text-xs leading-6 text-muted-foreground"><code${codeLanguageClass(lang)}>${escapeHtml(text)}</code></pre>`;
}

function isMermaidLanguage(lang: string | undefined) {
  return lang?.trim().split(/\s+/)[0]?.toLowerCase() === "mermaid";
}

function mermaidBlockHtml(text: string, presentation: MarkdownPresentation) {
  const borderClass = presentation === "surface" ? "border-dls-border/70" : "border-border/70";
  const backgroundClass = presentation === "surface" ? "bg-gray-1/80" : "bg-gray-2/60";
  const buttonClass = "rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50";

  return `<div data-openwork-mermaid="" data-openwork-mermaid-state="source" aria-busy="false" class="my-4 overflow-hidden rounded-[18px] border ${borderClass} ${backgroundClass}"><div class="flex min-h-10 items-center gap-2 border-b ${borderClass} px-3 py-2"><span class="me-auto text-xs font-medium text-muted-foreground">Mermaid diagram</span><div role="group" aria-label="Diagram view" class="flex items-center gap-1"><button type="button" data-openwork-mermaid-view="rendered" class="${buttonClass}" aria-pressed="false" disabled>Rendered</button><button type="button" data-openwork-mermaid-view="source" class="${buttonClass}" aria-pressed="true">Source</button><button type="button" data-openwork-mermaid-download="" class="${buttonClass}" aria-label="Download diagram as SVG" hidden>Download SVG</button></div></div><div data-openwork-mermaid-rendered="" class="overflow-auto p-4 [&amp;&gt;svg]:mx-auto [&amp;&gt;svg]:h-auto [&amp;&gt;svg]:max-w-full" hidden></div><pre data-openwork-mermaid-source="" class="overflow-x-auto p-4 text-xs leading-6 text-foreground"><code class="language-mermaid">${escapeHtml(text)}</code></pre><p data-openwork-mermaid-status="" class="border-t ${borderClass} px-3 py-2 text-xs text-muted-foreground" aria-live="polite">Diagram source</p></div>`;
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

export function codeWrapClassStates(wrapped: boolean) {
  return {
    "overflow-x-auto": !wrapped,
    "overflow-x-hidden": wrapped,
    "whitespace-pre-wrap": wrapped,
    "break-words": wrapped,
  };
}

export function setCodeWrapButtonState(button: HTMLButtonElement, wrapped: boolean) {
  const codeBlock = button.closest("[data-openwork-code-block]");
  const pre = codeBlock?.querySelector("pre");

  for (const [className, enabled] of Object.entries(codeWrapClassStates(wrapped))) {
    for (const container of codeBlock?.querySelectorAll("[data-openwork-code-scroll]") ?? []) {
      container.classList.toggle(className, enabled);
    }
  }
  pre?.classList.toggle("whitespace-pre-wrap", wrapped);
  pre?.classList.toggle("break-words", wrapped);
  button.setAttribute("aria-pressed", String(wrapped));
  button.setAttribute("aria-label", wrapped ? "Disable word wrap" : "Enable word wrap");
  button.title = wrapped ? "Disable word wrap" : "Enable word wrap";
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
      "controls",
      "playsinline",
      "preload",
      "checked",
      "class",
      "data-openwork-math-error",
      "data-openwork-code-block",
      "data-openwork-code-copy",
      "data-openwork-code-copy-check-icon",
      "data-openwork-code-copy-icon",
      "data-openwork-code-copy-label",
      "data-openwork-code-scroll",
      "data-openwork-code-wrap",
      "aria-label",
      "aria-pressed",
      "data-openwork-image-preview",
      "data-openwork-inline-code-path",
      "data-openwork-link-href",
      "data-openwork-link-chevron",
      "data-openwork-shiki",
      "decoding",
      "disabled",
      "hidden",
      "loading",
       "rel",
       "role",
       "start",
       "style",
       "tabindex",
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
    shikiContainer: chatCodeBlockContainer(`<div data-openwork-code-scroll="" class="overflow-x-auto px-4 pb-3 pt-11">%s</div>`, true),
    shikiTheme: { kind: "dual", light: "github-light", dark: "github-dark" },
  };
}

function renderVideo(href: string, label: string) {
  if (!/\.(?:mp4|webm|mov|m4v|ogv)(?:[?#].*)?$/i.test(href)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^(?:https?|file):/i.test(href) && !/^[A-Za-z]:[\\/]/.test(href)) return null;
  const remote = /^https?:/i.test(href);
  const source = remote ? ` src="${escapeAttribute(safeHref(href))}"` : "";
  const fileLink = remote
    ? `href="${escapeAttribute(safeHref(href))}" target="_blank" rel="noopener noreferrer"`
    : `href="#" data-openwork-inline-code-path="${escapeAttribute(href)}"`;
  return `<span class="my-4 inline-block w-full max-w-lg align-top"><video data-openwork-video-path="${escapeAttribute(href)}"${source} controls playsinline preload="metadata" aria-label="${escapeAttribute(label)}" class="block max-h-80 w-full rounded-lg border border-border/70 bg-black"></video><span data-openwork-video-error="" hidden class="text-sm text-muted-foreground">Video preview unavailable. Open the file to play it.</span><a ${fileLink} class="text-sm text-indigo-10">${escapeHtml(label)}</a></span>`;
}

function renderLink(profile: MarkdownProfile, href: string, title: string | null | undefined, text: string) {
  const video = profile.linkPresentation === "chat" ? renderVideo(href, href) : null;
  if (video) return video;
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
  const video = profile.linkPresentation === "chat" ? renderVideo(href, href) : null;
  if (video) return video;
  const safe = escapeAttribute(safeHref(href));
  const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";

  if (profile.imagePresentation === "chat") {
    return `<button type="button" data-openwork-image-preview="" class="my-4 inline-block max-w-full cursor-zoom-in align-top text-left transition-opacity hover:opacity-90" aria-label="Expand ${escapeAttribute(text)}"><img src="${safe}" alt="${escapeAttribute(text)}"${titleAttr} loading="lazy" decoding="async" class="block h-auto w-auto rounded-lg border border-border/70 object-contain" style="max-height: ${MARKDOWN_IMAGE_PREVIEW_MAX_HEIGHT}px; max-width: ${MARKDOWN_IMAGE_PREVIEW_MAX_WIDTH}px"></button>`;
  }

  return `<img src="${safe}" alt="${escapeAttribute(text)}"${titleAttr} loading="lazy" decoding="async" class="my-4 max-w-full rounded-[18px] border border-dls-border/70">`;
}

function createMarkedOptions(profile: MarkdownProfile, presentation: MarkdownPresentation, isAsync: boolean) {
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
        if (isMermaidLanguage(lang)) return mermaidBlockHtml(text, presentation);
        return profile.codeBlockHtml(text, lang);
      },
      codespan({ text }) {
        const path = profile.linkPresentation === "chat" ? inlineCodeArtifactPath(text) : null;
        const video = path ? renderVideo(path, path) : null;
        if (video) return video;
        const pathAttributes = path
          ? ` data-openwork-inline-code-path="${escapeAttribute(path)}" role="button" tabindex="0" aria-label="Open ${escapeAttribute(path)}"`
          : "";
        const pathClassName = path ? " cursor-pointer transition-colors hover:bg-gray-3/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" : "";
        return `<code${pathAttributes} class="${profile.codeSpanClassName}${pathClassName}">${escapeHtml(text)}</code>`;
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

function isCodeToken(token: Token): token is Tokens.Code {
  return token.type === "code" && "text" in token && typeof token.text === "string";
}

async function highlightedCodeHtml(
  token: Tokens.Code,
  profile: MarkdownProfile,
) {
  const [rawLanguage = "text", ...props] = token.lang?.split(" ") ?? [];
  const language = parseShikiLanguage(rawLanguage);
  const html = profile.shikiTheme.kind === "dual"
    ? await codeToHtml(token.text, {
      lang: language,
      meta: { __raw: props.join(" ") },
      themes: {
        light: profile.shikiTheme.light,
        dark: profile.shikiTheme.dark,
      },
      transformers: markdownTransformers(),
    })
    : await codeToHtml(token.text, {
      lang: language,
      meta: { __raw: props.join(" ") },
      theme: profile.shikiTheme.theme,
      transformers: markdownTransformers(),
    });

  return profile.shikiContainer.replace("%s", html);
}

function highlightedCodeExtension(profile: MarkdownProfile): MarkedExtension<string, string> {
  return {
    async: true,
    async walkTokens(token) {
      if (!isCodeToken(token) || isMermaidLanguage(token.lang)) return;
      const html = await highlightedCodeHtml(token, profile);
      Object.assign(token, { type: "html", block: true, text: `${html}\n` });
    },
  };
}

function createMarkdownParsers(presentation: MarkdownPresentation) {
  const profile = markdownProfileForPresentation(presentation);
  const markdownParser = new Marked<string, string>(createMarkedOptions(profile, presentation, false)).use(
    markedEmoji({
      emojis: emojiAliases,
      renderer: (token) => escapeHtml(token.emoji),
    }),
    markdownMath(),
  );
  // Math must be registered on both parsers, otherwise formulas would flicker away
  // when a message containing a fenced code block upgrades to the Shiki render.
  const highlightedMarkdownParser = new Marked<string, string>(createMarkedOptions(profile, presentation, true)).use(
    markedEmoji({
      emojis: emojiAliases,
      renderer: (token) => escapeHtml(token.emoji),
    }),
    markdownMath(),
    highlightedCodeExtension(profile),
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

/**
 * `dangerouslySetInnerHTML` payload for one top-level markdown block. The same
 * object is returned for as long as that block's source is unchanged, so React
 * leaves its DOM alone while later blocks keep streaming in.
 */
export type MarkdownBlockHtml = { readonly __html: string };

export type StreamingMarkdownRenderer = {
  /** Sanitized HTML for every top-level block of `text`, in document order. */
  render: (text: string) => MarkdownBlockHtml[];
  /** Drop the retained tokens once the message has settled. */
  reset: () => void;
};

type StreamingMarkdownState = {
  source: string;
  tokens: Token[];
  blocks: MarkdownBlockHtml[];
};

/**
 * Blocks re-lexed on every append: the one still growing plus its predecessor,
 * because a growing block can retroactively reshape the block before it (lazy
 * list continuation, a setext underline, a table delimiter row).
 */
const STREAMING_RELEX_TAIL = 2;

function hasReferenceDefinition(tokens: Token[]) {
  return tokens.some((token) => token.type === "def");
}

/**
 * Incremental markdown renderer for a message that is still streaming. A full
 * `renderMarkdownHtml` re-lexes, re-parses, and re-sanitizes the whole answer
 * for every token that arrives, so each frame costs as much as the text so far.
 * This keeps the previous frame's top-level tokens and re-lexes only the tail
 * of an appended source; settled blocks reuse their previous HTML payload.
 *
 * Reference-style link definitions resolve across blocks, so a source that
 * contains one always takes the full lex.
 */
export function createStreamingMarkdownRenderer(presentation: MarkdownPresentation = "chat"): StreamingMarkdownRenderer {
  const { markdownParser } = parsersForPresentation(presentation);
  let state: StreamingMarkdownState | null = null;

  const renderBlock = (token: Token): MarkdownBlockHtml => ({
    __html: sanitizeMarkdownHtml(markdownParser.parser([token])),
  });

  const renderAll = (source: string, previous: StreamingMarkdownState | null): StreamingMarkdownState => {
    const tokens = markdownParser.lexer(source);
    const reusable = previous && !hasReferenceDefinition(tokens) && !hasReferenceDefinition(previous.tokens)
      ? previous
      : null;
    const blocks = tokens.map((token, index) => {
      const priorToken = reusable?.tokens[index];
      const priorBlock = reusable?.blocks[index];
      return priorToken && priorBlock && priorToken.raw === token.raw ? priorBlock : renderBlock(token);
    });
    return { source, tokens, blocks };
  };

  const renderAppended = (source: string, previous: StreamingMarkdownState): StreamingMarkdownState | null => {
    const keep = previous.tokens.length - STREAMING_RELEX_TAIL;
    if (keep <= 0 || hasReferenceDefinition(previous.tokens)) return null;

    let offset = 0;
    for (const token of previous.tokens.slice(0, keep)) offset += token.raw.length;
    const tail = markdownParser.lexer(source.slice(offset));
    if (hasReferenceDefinition(tail)) return null;

    return {
      source,
      tokens: [...previous.tokens.slice(0, keep), ...tail],
      blocks: [...previous.blocks.slice(0, keep), ...tail.map(renderBlock)],
    };
  };

  return {
    render(text) {
      // Marked normalizes line endings before lexing; mirror it so token raw
      // lengths index into `source`.
      const source = text.replace(/\r\n|\r/g, "\n");
      if (state?.source === source) return state.blocks;

      const appended = state && source.startsWith(state.source) ? renderAppended(source, state) : null;
      state = appended ?? renderAll(source, state);
      return state.blocks;
    },
    reset() {
      state = null;
    },
  };
}

export async function renderHighlightedMarkdownHtml(text: string, presentation: MarkdownPresentation = "chat") {
  const { highlightedMarkdownParser } = parsersForPresentation(presentation);
  const html = await highlightedMarkdownParser.parse(text, { async: true });
  return sanitizeMarkdownHtml(html);
}
