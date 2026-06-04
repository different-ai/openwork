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

import { applyTextHighlights } from "./text-highlights";

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

function parseShikiLanguage(lang: string) {
  const normalized = lang.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return normalized in bundledLanguages ? normalized : "text";
}

function hasFencedCodeBlock(text: string) {
  return /(^|\n)```/.test(text);
}

function sanitizeMarkdownHtml(value: string) {
  return DOMPurify.sanitize(value, {
    ADD_ATTR: [
      "checked",
      "class",
      "data-openwork-shiki",
      "decoding",
      "disabled",
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
      const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";

      return `<a href="${safe}"${titleAttr} target="_blank" rel="noreferrer noopener" class="text-indigo-10 underline underline-offset-2 transition-colors hover:text-indigo-8">${this.parser.parseInline(tokens)}</a>`;
    },
    image({ href, title, text }) {
      const safe = escapeAttribute(safeHref(href));
      const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";

      return `<img src="${safe}" alt="${escapeAttribute(text)}"${titleAttr} loading="lazy" decoding="async" class="my-4 max-w-full rounded-lg border border-border/70">`;
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

  if (!html) {
    return null;
  }

  return (
    <motion.div
      ref={rootRef}
      className={cn("markdown-content max-w-none text-foreground", className)}
      dangerouslySetInnerHTML={{ __html: html }}
      {...props}
    />
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
