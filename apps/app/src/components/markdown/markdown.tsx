/** @jsxImportSource react */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import DOMPurify from "dompurify";
import { Marked, type Tokens } from "marked";
import { markedEmoji } from "marked-emoji";
import markedShiki from "marked-shiki";
import emojiKeywords from "emojilib";
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

import { cn } from "@/lib/utils";
import { useOpenTargets } from "@/lib/target-provider";
import type { OpenTarget } from "@/react-app/domains/session/artifacts/open-target";

import { applyTextHighlights } from "./text-highlights";
import { LinkActionMenu } from "./link-action-menu";

const WORKSPACES_PREFIX_PATTERN = /^workspaces\/[^/]+\//i;
const WORKSPACE_ID_PREFIX_PATTERN = /^workspace\/(?:ws_[^/]+|\d+|[0-9a-f-]{6,})\//i;

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

function localPathFromHref(href: string) {
  const trimmed = href.trim();

  if (!trimmed || trimmed.startsWith("#") || /^(?:https?|mailto):/i.test(trimmed)) {
    return "";
  }

  if (/^file:/i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const host = decodeURIComponent(parsed.hostname);
      const pathname = decodeURIComponent(parsed.pathname);
      const localPath = /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;

      if (host && host !== "localhost") {
        return `//${host}${localPath.startsWith("/") ? localPath : `/${localPath}`}`;
      }

      return localPath;
    } catch {
      return "";
    }
  }

  return trimmed.split(/[?#]/)[0] ?? trimmed;
}

function normalizeFilePathForMatch(path: string) {
  return path
    .trim()
    .replace(/[\\]+/g, "/")
    .replace(/^\.\//, "")
    .replace(WORKSPACES_PREFIX_PATTERN, "")
    .replace(WORKSPACE_ID_PREFIX_PATTERN, "")
    .replace(/[/]+$/, "")
    .toLowerCase();
}

function filePathMatchesTarget(path: string, targetValue: string) {
  const normalizedPath = normalizeFilePathForMatch(path);
  const normalizedTarget = normalizeFilePathForMatch(targetValue);

  return normalizedPath === normalizedTarget || normalizedPath.endsWith(`/${normalizedTarget}`);
}

function openTargetForHref(href: string, openTargets: OpenTarget[]) {
  const path = localPathFromHref(href);

  if (!path) {
    return null;
  }

  return openTargets.find((target) => target.kind === "file" && filePathMatchesTarget(path, target.value)) ?? null;
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
const MARKDOWN_IMAGE_PREVIEW_MAX_HEIGHT = 100;

function parseShikiLanguage(lang: string) {
  const normalized = lang.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return normalized in bundledLanguages ? normalized : "text";
}

function hasFencedCodeBlock(text: string) {
  return /(^|\n)```/.test(text);
}

function estimatedRenderedImageHeight(image: HTMLImageElement) {
  if (!image.naturalWidth || !image.naturalHeight) return 0;

  const renderedWidth = image.clientWidth || image.getBoundingClientRect().width;
  return renderedWidth > 0
    ? (image.naturalHeight / image.naturalWidth) * renderedWidth
    : image.naturalHeight;
}

function syncMarkdownImagePreviews(root: HTMLElement) {
  const previews = root.querySelectorAll("[data-openwork-image-preview]");

  for (const preview of previews) {
    if (!(preview instanceof HTMLElement)) continue;

    const image = preview.querySelector("img");
    const button = preview.querySelector("[data-openwork-image-toggle]");
    if (!(image instanceof HTMLImageElement) || !(button instanceof HTMLButtonElement)) continue;

    const previewable = estimatedRenderedImageHeight(image) > MARKDOWN_IMAGE_PREVIEW_MAX_HEIGHT;
    button.hidden = !previewable;

    if (!previewable) {
      preview.style.maxHeight = "";
      continue;
    }

    const expanded = preview.dataset.openworkImagePreview === "expanded";
    preview.style.maxHeight = expanded ? "" : `${MARKDOWN_IMAGE_PREVIEW_MAX_HEIGHT}px`;

    const label = button.querySelector("[data-openwork-image-toggle-label]");
    if (label) label.textContent = expanded ? "Show less" : "Show full image";
  }
}

function sanitizeMarkdownHtml(value: string) {
  return DOMPurify.sanitize(value, {
    ADD_ATTR: [
      "checked",
      "class",
      "data-openwork-image-preview",
      "data-openwork-image-toggle",
      "data-openwork-image-toggle-label",
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

const baseMarkedOptions = {
  async: false,
  breaks: false,
  gfm: true,
  pedantic: false,
  silent: true,
  renderer: {
    html({ text }) {
      return text;
    },
    paragraph({ tokens }) {
      return `<p class="my-3 leading-relaxed">${this.parser.parseInline(tokens)}</p>`;
    },
    heading({ tokens, depth }) {
      const className = cn(
        "font-semibold",
        depth === 1 && "my-5 text-xl",
        depth === 2 && "my-4 text-lg",
        depth >= 3 && "my-3 text-base",
      );

      return `<h${depth} class="${className}">${this.parser.parseInline(tokens)}</h${depth}>`;
    },
    list(token) {
      const tag = token.ordered ? "ol" : "ul";
      const className = cn(
        "my-3 pl-6",
        token.ordered ? "list-decimal" : "list-disc",
      );
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
      return `<blockquote class="my-4 rounded-r-lg border-l border-border bg-muted/40 pl-4 italic text-muted-foreground">${this.parser.parse(tokens)}</blockquote>`;
    },
    code({ text, lang }) {
      return `<pre class="my-4 overflow-x-auto rounded-[18px] border border-border/70 bg-gray-1/80 px-4 py-3 text-xs leading-6 text-muted-foreground"><code${codeLanguageClass(lang)}>${escapeHtml(text)}</code></pre>`;
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
      const safe = escapeAttribute(safeHref(href));
      const originalHref = escapeAttribute(href);
      const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
      const isFilePath = !/^(https?|wss?|ftp|mailto|tel|file):/i.test(href);

      if (isFilePath) {
        const fileIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/></svg>`;
        const chevron = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><path d="m6 9 6 6 6-6"/></svg>`;

        return `<span class="inline-flex items-stretch overflow-hidden rounded-md border border-border/60 bg-muted/40 text-xs font-medium text-foreground align-middle"><a href="${safe}" data-openwork-link-href="${originalHref}"${titleAttr} target="_blank" rel="noreferrer noopener" class="inline-flex items-center gap-1 px-1.5 py-0.5 no-underline transition-colors hover:bg-muted">${fileIcon}${this.parser.parseInline(tokens)}</a><button type="button" data-openwork-link-chevron="${originalHref}" class="inline-flex items-center border-l border-border/60 px-1 transition-colors hover:bg-muted" aria-label="Open with">${chevron}</button></span>`;
      }

      return `<a href="${safe}" data-openwork-link-href="${originalHref}"${titleAttr} target="_blank" rel="noreferrer noopener" class="text-indigo-10 underline underline-offset-2 transition-colors hover:text-indigo-8">${this.parser.parseInline(tokens)}</a>`;
    },
    image({ href, title, text }) {
      const safe = escapeAttribute(safeHref(href));
      const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";

      return `<span data-openwork-image-preview="collapsed" class="relative my-4 inline-block max-w-full overflow-hidden rounded-lg border border-border/70 align-top" style="max-height: ${MARKDOWN_IMAGE_PREVIEW_MAX_HEIGHT}px"><img src="${safe}" alt="${escapeAttribute(text)}"${titleAttr} loading="lazy" decoding="async" class="block h-auto max-w-full"><button type="button" data-openwork-image-toggle="" hidden class="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-background via-background/90 to-transparent pb-2 pt-8"><span data-openwork-image-toggle-label="" class="rounded-full border border-border bg-background/95 px-3 py-1 text-xs font-medium text-foreground shadow-sm">Show full image</span></button></span>`;
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
      const className = cn(
        "border border-border p-2",
        header ? "bg-muted text-left" : "align-top",
      );

      if (header) {
        return `<th${alignAttribute(align)} class="${className}">${this.parser.parseInline(tokens)}</th>`;
      }

      return `<td${alignAttribute(align)} class="${className}">${this.parser.parseInline(tokens)}</td>`;
    },
    hr() {
      return `<hr class="my-6 border-none h-px bg-gray-4">`;
    },
  },
} satisfies ConstructorParameters<typeof Marked<string, string>>[0];

const markdownParser = new Marked(baseMarkedOptions).use(
  markedEmoji({
    emojis: emojiAliases,
    renderer: (token) => escapeHtml(token.emoji),
  }),
);

const highlightedMarkdownParser = new Marked({
  ...baseMarkedOptions,
  async: true,
}).use(
  markedEmoji({
    emojis: emojiAliases,
    renderer: (token) => escapeHtml(token.emoji),
  }),
  markedShiki({
    async highlight(code, lang, props) {
      const language = parseShikiLanguage(lang);

      return codeToHtml(code, {
        lang: language,
        meta: { __raw: props.join(" ") },
        theme: "github-light",
        transformers: [
          transformerNotationDiff({ matchAlgorithm: "v3" }),
          transformerNotationHighlight({ matchAlgorithm: "v3" }),
          transformerNotationWordHighlight({ matchAlgorithm: "v3" }),
          transformerNotationFocus({ matchAlgorithm: "v3" }),
          transformerNotationErrorLevel({ matchAlgorithm: "v3" }),
          transformerMetaHighlight(),
          transformerMetaWordHighlight(),
        ],
      });
    },
    container: `<div data-openwork-shiki="true" class="my-4 overflow-hidden rounded-lg border border-border/70 bg-gray-1/80 p-4 text-xs leading-6">%s</div>`,
  }),
);

type MarkdownBlockInnerProps = {
  className?: string;
  text: string;
  streaming?: boolean;
  highlightQuery?: string;
} & Omit<
  React.ComponentProps<typeof motion.div>,
  "ref" | "className" | "children" | "dangerouslySetInnerHTML"
>;

function MarkdownBlockInner({
  className,
  text,
  streaming,
  highlightQuery,
  ...props
}: MarkdownBlockInnerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { openTargets, onOpenTarget } = useOpenTargets();
  const [linkMenu, setLinkMenu] = useState<{ target: OpenTarget; rect: DOMRect } | null>(null);
  const syncHtml = useMemo(() => {
    if (!text.trim()) {
      return "";
    }
    return sanitizeMarkdownHtml(markdownParser.parse(text, { async: false }));
  }, [text]);
  const [highlightedHtml, setHighlightedHtml] = useState<{ text: string; html: string } | null>(null);

  useEffect(() => {
    if (streaming || !hasFencedCodeBlock(text)) {
      setHighlightedHtml(null);
      return;
    }

    let cancelled = false;
    void highlightedMarkdownParser.parse(text, { async: true }).then((html) => {
      const sanitizedHtml = sanitizeMarkdownHtml(html);

      if (!cancelled && sanitizedHtml.trim()) {
        setHighlightedHtml({ text, html: sanitizedHtml });
      }
    }).catch(() => {
      if (!cancelled) {
        setHighlightedHtml(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [streaming, text]);

  const html = !streaming && highlightedHtml?.text === text ? highlightedHtml.html : syncHtml;

  useEffect(() => {
    const root = rootRef.current;

    if (!root) {
      return;
    }

    queueMicrotask(() => {
      if (!rootRef.current || rootRef.current !== root) {
        return;
      }

      applyTextHighlights(root, highlightQuery ?? "");
    });
  }, [html, highlightQuery]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const sync = () => syncMarkdownImagePreviews(root);

    sync();

    const handleLoad = (event: Event) => {
      if (event.target instanceof HTMLImageElement) sync();
    };

    const handleClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;

      const chevron = event.target.closest("[data-openwork-link-chevron]");
      if (chevron instanceof HTMLElement) {
        event.preventDefault();
        event.stopPropagation();
        const href = chevron.dataset.openworkLinkChevron ?? "";
        const target = openTargetForHref(href, openTargets);
        if (target) {
          setLinkMenu({ target, rect: chevron.getBoundingClientRect() });
        }
        return;
      }

      const link = event.target.closest("a[data-openwork-link-href]");
      if (link instanceof HTMLAnchorElement) {
        const href = link.dataset.openworkLinkHref ?? link.getAttribute("href") ?? "";
        const target = openTargetForHref(href, openTargets);

        if (target && onOpenTarget) {
          event.preventDefault();
          onOpenTarget(target, { external: true });
          return;
        }
      }

      const button = event.target.closest("[data-openwork-image-toggle]");
      if (!(button instanceof HTMLButtonElement)) return;

      const preview = button.closest("[data-openwork-image-preview]");
      if (!(preview instanceof HTMLElement)) return;

      preview.dataset.openworkImagePreview = preview.dataset.openworkImagePreview === "expanded"
        ? "collapsed"
        : "expanded";
      sync();
    };

    root.addEventListener("load", handleLoad, true);
    root.addEventListener("click", handleClick);

    if (globalThis.ResizeObserver === undefined) {
      return () => {
        root.removeEventListener("load", handleLoad, true);
        root.removeEventListener("click", handleClick);
      };
    }

    const observer = new ResizeObserver(sync);
    observer.observe(root);

    return () => {
      observer.disconnect();
      root.removeEventListener("load", handleLoad, true);
      root.removeEventListener("click", handleClick);
    };
  }, [html, onOpenTarget, openTargets]);

  if (!html) {
    return null;
  }

  return (
    <>
      <motion.div
        ref={rootRef}
        className={cn("markdown-content max-w-none text-foreground", className)}
        dangerouslySetInnerHTML={{ __html: html }}
        {...props}
      />
      {linkMenu && onOpenTarget ? (
        <LinkActionMenu
          target={linkMenu.target}
          anchorRect={linkMenu.rect}
          onOpenTarget={onOpenTarget}
          onClose={() => setLinkMenu(null)}
        />
      ) : null}
    </>
  );
}

/**
 * Memoize so a message block that has already been rendered — the usual
 * case for every assistant bubble above the currently-streaming one —
 * doesn't re-parse its markdown on every token. Only re-renders when its
 * own text / streaming / highlightQuery props change.
 */
export const MarkdownBlock = memo(MarkdownBlockInner);
MarkdownBlock.displayName = "MarkdownBlock";
