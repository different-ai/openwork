import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import { marked } from "marked";
import type { Part } from "@opencode-ai/sdk/v2/client";
import { Check, Copy } from "lucide-solid";
import type { ArtifactItem } from "../../types";
import { usePlatform } from "../../context/platform";
import { splitSessionContentBlocks, type SessionContentBlock } from "../../session/content-blocks";
import {
  dedupeFileReferenceCards,
  fileReferenceCardFromArtifact,
  type FileReferenceCard,
} from "../../session/file-presentations";
import {
  normalizeFilePath,
  parseLinkFromToken,
  splitTextTokens,
} from "../../session/file-links";
import { perfNow, recordPerfLog } from "../../lib/perf-log";
import { isTauriRuntime } from "../../utils";
import FileCard from "./file-card";

type Props = {
  part: Part;
  developerMode?: boolean;
  tone?: "light" | "dark";
  workspaceRoot?: string;
  renderMarkdown?: boolean;
  markdownThrottleMs?: number;
  highlightQuery?: string;
  artifacts?: ArtifactItem[];
};

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function useThrottledValue<T>(value: () => T, delayMs: number | (() => number) = 48) {
  const [state, setState] = createSignal<T>(value());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hasEmitted = false;

  createEffect(() => {
    const next = value();
    const delay = typeof delayMs === "function" ? delayMs() : delayMs;
    if (!delay || !hasEmitted) {
      hasEmitted = true;
      setState(() => next);
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      setState(() => next);
      timer = undefined;
    }, delay);
  });

  onCleanup(() => {
    if (timer) clearTimeout(timer);
  });

  return state;
}

const MARKDOWN_CACHE_MAX_ENTRIES = 300;
const LARGE_TEXT_COLLAPSE_CHAR_THRESHOLD = 12_000;
const LARGE_TEXT_PREVIEW_CHARS = 3_200;
const SEARCH_HIGHLIGHT_MARK_ATTR = "data-openwork-highlight";
const markdownHtmlCache = new Map<string, string>();
const expandedLargeTextPartIds = new Set<string>();
const rendererByTone = new Map<"light" | "dark", ReturnType<typeof createCustomRenderer>>();

function markdownCacheKey(tone: "light" | "dark", text: string) {
  return `${tone}\u0000${text}`;
}

function readMarkdownCache(key: string) {
  const cached = markdownHtmlCache.get(key);
  if (cached === undefined) return undefined;
  markdownHtmlCache.delete(key);
  markdownHtmlCache.set(key, cached);
  return cached;
}

function writeMarkdownCache(key: string, html: string) {
  if (markdownHtmlCache.has(key)) markdownHtmlCache.delete(key);
  markdownHtmlCache.set(key, html);
  while (markdownHtmlCache.size > MARKDOWN_CACHE_MAX_ENTRIES) {
    const oldest = markdownHtmlCache.keys().next().value;
    if (!oldest) break;
    markdownHtmlCache.delete(oldest);
  }
}

function rendererForTone(tone: "light" | "dark") {
  const cached = rendererByTone.get(tone);
  if (cached) return cached;
  const next = createCustomRenderer(tone);
  rendererByTone.set(tone, next);
  return next;
}

function createCustomRenderer(tone: "light" | "dark") {
  const renderer = new marked.Renderer();
  const inlineCodeClass =
    tone === "dark"
      ? "bg-gray-12/15 text-gray-12"
      : "bg-gray-2/70 text-gray-12";

  const isSafeUrl = (url: string) => {
    const normalized = (url || "").trim().toLowerCase();
    if (normalized.startsWith("javascript:")) return false;
    if (normalized.startsWith("data:")) return normalized.startsWith("data:image/");
    return true;
  };

  renderer.html = ({ text }) => escapeHtml(text);
  renderer.codespan = ({ text }) => {
    return `<code class="rounded-md px-1.5 py-0.5 text-[13px] font-mono ${inlineCodeClass}">${escapeHtml(
      text,
    )}</code>`;
  };
  renderer.link = ({ href, title, text }) => {
    const safeHref = isSafeUrl(href ?? "") ? escapeHtml(href ?? "#") : "#";
    const safeTitle = title ? escapeHtml(title) : "";
    return `
      <a
        href="${safeHref}"
        target="_blank"
        rel="noopener noreferrer"
        class="underline underline-offset-2 text-dls-accent hover:text-[var(--dls-accent-hover)]"
        ${safeTitle ? `title="${safeTitle}"` : ""}
      >
        ${text}
      </a>
    `;
  };
  renderer.image = ({ href, title, text }) => {
    const safeHref = isSafeUrl(href ?? "") ? escapeHtml(href ?? "") : "";
    const safeTitle = title ? escapeHtml(title) : "";
    return `
      <img
        src="${safeHref}"
        alt="${escapeHtml(text || "")}" 
        ${safeTitle ? `title="${safeTitle}"` : ""}
        loading="lazy"
        decoding="async"
        class="max-w-full h-auto rounded-lg my-4"
      />
    `;
  };

  return renderer;
}

function applyTextHighlights(root: HTMLElement, query: string) {
  root.querySelectorAll(`[${SEARCH_HIGHLIGHT_MARK_ATTR}]`).forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
    parent.normalize();
  });

  const needle = query.trim().toLowerCase();
  if (!needle) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("script, style, button, mark")) return NodeFilter.FILTER_REJECT;
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    textNodes.push(node as Text);
    node = walker.nextNode();
  }

  textNodes.forEach((textNode) => {
    const text = textNode.textContent ?? "";
    const lower = text.toLowerCase();
    let searchIndex = 0;
    let matchIndex = lower.indexOf(needle, searchIndex);
    if (matchIndex === -1) return;

    const fragment = document.createDocumentFragment();
    while (matchIndex !== -1) {
      if (matchIndex > searchIndex) {
        fragment.appendChild(document.createTextNode(text.slice(searchIndex, matchIndex)));
      }
      const mark = document.createElement("mark");
      mark.setAttribute(SEARCH_HIGHLIGHT_MARK_ATTR, "true");
      mark.className = "rounded px-0.5 bg-amber-4/70 text-current";
      mark.textContent = text.slice(matchIndex, matchIndex + needle.length);
      fragment.appendChild(mark);
      searchIndex = matchIndex + needle.length;
      matchIndex = lower.indexOf(needle, searchIndex);
      if (matchIndex === -1) {
        fragment.appendChild(document.createTextNode(text.slice(searchIndex)));
      }
    }
    textNode.parentNode?.replaceChild(fragment, textNode);
  });
}

function markdownHtmlForBlock(tone: "light" | "dark", raw: string, developerMode: boolean) {
  const key = markdownCacheKey(tone, raw);
  const cached = readMarkdownCache(key);
  if (cached !== undefined) return cached;

  const startedAt = perfNow();
  const html = String(
    marked.parse(raw, {
      breaks: true,
      gfm: true,
      renderer: rendererForTone(tone),
      async: false,
    }) ?? "",
  );
  const parseMs = Math.round((perfNow() - startedAt) * 100) / 100;
  if (developerMode && (parseMs >= 8 || raw.length >= 2_500)) {
    recordPerfLog(true, "session.render", "markdown-block-parse", {
      chars: raw.length,
      ms: parseMs,
    });
  }
  writeMarkdownCache(key, html);
  return html;
}

type MarkdownBlockViewProps = {
  block: Extract<SessionContentBlock, { kind: "markdown" }>;
  tone: "light" | "dark";
  developerMode: boolean;
  onLinkClick: (event: MouseEvent) => void;
};

function MarkdownBlockView(props: MarkdownBlockViewProps) {
  const html = createMemo(() => markdownHtmlForBlock(props.tone, props.block.raw, props.developerMode));
  return (
    <div
      class="markdown-content max-w-none [&_strong]:font-semibold [&_em]:italic [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:my-4 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:my-3 [&_h3]:text-lg [&_h3]:font-bold [&_h3]:my-2 [&_p]:my-3 [&_p]:leading-relaxed [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-3 [&_li]:my-1 [&_blockquote]:border-l-4 [&_blockquote]:border-dls-border [&_blockquote]:pl-4 [&_blockquote]:my-4 [&_blockquote]:italic [&_table]:w-full [&_table]:border-collapse [&_table]:my-4 [&_th]:border [&_th]:border-dls-border [&_th]:p-2 [&_th]:bg-dls-hover [&_td]:border [&_td]:border-dls-border [&_td]:p-2"
      innerHTML={html()}
      onClick={props.onLinkClick}
    />
  );
}

function CodeBlockView(props: { block: Extract<SessionContentBlock, { kind: "code" }>; tone: "light" | "dark" }) {
  const [copied, setCopied] = createSignal(false);
  let copyTimer: number | undefined;

  onCleanup(() => {
    if (copyTimer !== undefined) {
      window.clearTimeout(copyTimer);
    }
  });

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(props.block.code);
      setCopied(true);
      if (copyTimer !== undefined) window.clearTimeout(copyTimer);
      copyTimer = window.setTimeout(() => {
        setCopied(false);
        copyTimer = undefined;
      }, 1800);
    } catch {
      // ignore
    }
  };

  const shellClass = () =>
    props.tone === "dark"
      ? "border-gray-11/20 bg-gray-12/10 text-gray-12"
      : "border-gray-6/70 bg-gray-1/70 text-gray-12";

  return (
    <div class={`my-4 rounded-[22px] border px-4 py-3 ${shellClass()}`.trim()}>
      <div class="mb-3 flex items-center justify-between gap-3">
        <div class="text-[10px] uppercase tracking-[0.2em] text-gray-9">
          {props.block.lang || "code"}
        </div>
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-full border border-dls-border bg-dls-surface px-2.5 py-1 text-[11px] font-medium text-gray-11 transition-colors hover:bg-dls-hover hover:text-gray-12"
          onClick={() => {
            void copyCode();
          }}
        >
          <Show when={copied()} fallback={<Copy size={12} />}>
            <Check size={12} class="text-green-10" />
          </Show>
          {copied() ? "Copied" : "Copy"}
        </button>
      </div>
      <pre class="overflow-x-auto whitespace-pre text-[13px] leading-relaxed font-mono">
        <code>{props.block.code}</code>
      </pre>
    </div>
  );
}

export default function MessageContent(props: Props) {
  const platform = usePlatform();
  const tone = () => props.tone ?? "light";
  const textClass = () => "text-gray-12";
  const part = () => props.part;
  const renderMarkdown = () => props.renderMarkdown ?? false;
  const markdownThrottleMs = () => Math.max(0, props.markdownThrottleMs ?? 48);
  const rawText = createMemo(() => {
    if (part().type !== "text") return "";
    return String((part() as { text?: string }).text ?? "");
  });
  const textPartStableId = createMemo(() => {
    if (part().type !== "text") return "";
    const record = part() as { id?: string | number; messageID?: string | number };
    const partId = record.id;
    if (typeof partId === "string") return partId;
    if (typeof partId === "number") return String(partId);
    const messageId = record.messageID;
    if (typeof messageId === "string") return `msg:${messageId}`;
    if (typeof messageId === "number") return `msg:${String(messageId)}`;
    return "";
  });
  const isPersistedExpanded = () => {
    const id = textPartStableId();
    return Boolean(id && expandedLargeTextPartIds.has(id));
  };
  const [expandedLongText, setExpandedLongText] = createSignal(isPersistedExpanded());
  createEffect(() => {
    if (!isPersistedExpanded() || expandedLongText()) return;
    setExpandedLongText(true);
  });
  const shouldCollapseLongText = createMemo(
    () => renderMarkdown() && part().type === "text" && rawText().length >= LARGE_TEXT_COLLAPSE_CHAR_THRESHOLD,
  );
  const collapsedLongText = createMemo(
    () => shouldCollapseLongText() && !(expandedLongText() || isPersistedExpanded()),
  );
  const collapsedPreviewText = createMemo(() => {
    const text = rawText();
    if (!collapsedLongText()) return text;
    if (text.length <= LARGE_TEXT_PREVIEW_CHARS) return text;
    return `${text.slice(0, LARGE_TEXT_PREVIEW_CHARS)}\n\n...`;
  });
  const markdownSource = createMemo(() => {
    if (!renderMarkdown() || part().type !== "text") return "";
    if (collapsedLongText()) return "";
    return rawText();
  });
  const throttledMarkdownSource = useThrottledValue(markdownSource, markdownThrottleMs);
  let previousBlocks: SessionContentBlock[] = [];
  const contentBlocks = createMemo(() => {
    if (!renderMarkdown() || part().type !== "text") return [] as SessionContentBlock[];
    const text = throttledMarkdownSource();
    if (!text.trim()) {
      previousBlocks = [];
      return [] as SessionContentBlock[];
    }
    const startedAt = perfNow();
    const next = splitSessionContentBlocks(text, previousBlocks);
    previousBlocks = next;
    const elapsedMs = Math.round((perfNow() - startedAt) * 100) / 100;
    if ((props.developerMode ?? false) && (elapsedMs >= 6 || text.length >= 6_000)) {
      recordPerfLog(true, "session.render", "content-blocks", {
        chars: text.length,
        blocks: next.length,
        ms: elapsedMs,
      });
    }
    return next;
  });
  const inlineFileCards = createMemo<FileReferenceCard[]>(() =>
    contentBlocks()
      .filter((block): block is Extract<SessionContentBlock, { kind: "file" }> => block.kind === "file")
      .map((block) => ({
        id: block.id,
        path: block.path,
        title: block.label,
        detail: block.path,
        source: "text" as const,
      })),
  );
  const mentionedFileCards = createMemo<FileReferenceCard[]>(() => {
    if (!renderMarkdown() || part().type !== "text") return [];
    return splitTextTokens(rawText())
      .filter((token): token is Extract<ReturnType<typeof splitTextTokens>[number], { kind: "link" }> => token.kind === "link")
      .filter((token) => token.type === "file")
      .map((token) => ({
        id: `mention:${token.href}`,
        path: token.href,
        detail: token.href,
        source: "text" as const,
      }));
  });
  const artifactCards = createMemo<FileReferenceCard[]>(() =>
    (props.artifacts ?? [])
      .map((artifact) => fileReferenceCardFromArtifact(artifact))
      .filter((value): value is FileReferenceCard => Boolean(value)),
  );
  const visibleArtifactCards = createMemo(() =>
    dedupeFileReferenceCards([...inlineFileCards(), ...mentionedFileCards(), ...artifactCards()]),
  );
  let textContainerEl: HTMLDivElement | undefined;

  const openLink = async (href: string, type: "url" | "file") => {
    if (type === "url") {
      platform.openLink(href);
      return;
    }

    const filePath = normalizeFilePath(href, props.workspaceRoot ?? "");
    if (!filePath) return;
    if (!isTauriRuntime()) {
      platform.openLink(href.startsWith("file://") ? href : `file://${filePath}`);
      return;
    }

    const { openPath, revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(filePath).catch(() => openPath(filePath));
  };

  const openMarkdownLink = async (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const anchor = target.closest("a");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const href = anchor.getAttribute("href")?.trim();
    if (!href) return;
    const link = parseLinkFromToken(href);
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    await openLink(link.href, link.type);
  };

  const renderTextWithLinks = () => {
    const text = rawText();
    if (!text) return <span>{""}</span>;
    const tokens = splitTextTokens(text);
    return (
      <span>
        <For each={tokens}>
          {(token) =>
            token.kind === "link" ? (
              <a
                href={token.href}
                target="_blank"
                rel="noopener noreferrer"
                class="underline underline-offset-2 text-dls-accent hover:text-[var(--dls-accent-hover)]"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void openLink(token.href, token.type);
                }}
              >
                {token.value}
              </a>
            ) : (
              token.value
            )
          }
        </For>
      </span>
    );
  };

  createEffect(() => {
    const root = textContainerEl;
    if (!root) return;
    const query = props.highlightQuery ?? "";
    const signature = `${rawText().length}:${contentBlocks().length}:${visibleArtifactCards().length}:${query}`;
    void signature;
    queueMicrotask(() => {
      if (!textContainerEl || textContainerEl !== root) return;
      applyTextHighlights(textContainerEl, query);
    });
  });

  if (part().type === "file") {
    const file = part() as {
      id?: string | number;
      filename?: string;
      url?: string;
      mime?: string;
      source?: {
        path?: string;
        name?: string;
        uri?: string;
      };
    };
    const sourcePath = typeof file.source?.path === "string" ? file.source.path : "";
    const sourceUri = typeof file.source?.uri === "string" ? file.source.uri : "";
    const path = sourcePath || file.url || sourceUri;
    return (
      <FileCard
        reference={{
          id: String(file.id ?? path),
          path,
          title: file.filename || file.source?.name,
          detail: sourcePath || sourceUri || file.url,
          mime: file.mime,
          source: "file-part",
        }}
        tone={tone()}
        workspaceRoot={props.workspaceRoot}
      />
    );
  }

  return (
    <div
      ref={(el) => {
        textContainerEl = el;
      }}
      class={textClass()}
    >
      <Show when={collapsedLongText()}>
        <div class="rounded-xl border border-gray-6/70 bg-gray-2/30 p-4 space-y-3">
          <div class="whitespace-pre-wrap break-words text-[14px] leading-relaxed max-h-[22rem] overflow-hidden">
            {collapsedPreviewText()}
          </div>
          <button
            type="button"
            class="rounded-md border border-gray-6/80 bg-gray-1 px-3 py-1.5 text-xs font-medium text-gray-11 hover:bg-gray-2 hover:text-gray-12"
            onClick={() => {
              const id = textPartStableId();
              if (id) expandedLargeTextPartIds.add(id);
              setExpandedLongText(true);
            }}
          >
            Show full message ({rawText().length.toLocaleString()} chars)
          </button>
        </div>
      </Show>

      <Show when={!collapsedLongText()}>
        <Show
          when={renderMarkdown()}
          fallback={<div class="whitespace-pre-wrap break-words">{renderTextWithLinks()}</div>}
        >
          <div class="space-y-1">
            <For each={contentBlocks()}>
              {(block) => (
                <Switch>
                  <Match when={block.kind === "markdown"}>
                    <MarkdownBlockView
                      block={block as Extract<SessionContentBlock, { kind: "markdown" }>}
                      tone={tone()}
                      developerMode={props.developerMode ?? false}
                      onLinkClick={openMarkdownLink}
                    />
                  </Match>
                  <Match when={block.kind === "code"}>
                    <CodeBlockView
                      block={block as Extract<SessionContentBlock, { kind: "code" }>}
                      tone={tone()}
                    />
                  </Match>
                  <Match when={block.kind === "file"}>
                    <div class="my-3">
                      <FileCard
                        reference={{
                          id: block.id,
                          path: (block as Extract<SessionContentBlock, { kind: "file" }>).path,
                          title: (block as Extract<SessionContentBlock, { kind: "file" }>).label,
                          detail: (block as Extract<SessionContentBlock, { kind: "file" }>).path,
                          source: "text",
                        }}
                        tone={tone()}
                        workspaceRoot={props.workspaceRoot}
                      />
                    </div>
                  </Match>
                </Switch>
              )}
            </For>
          </div>
        </Show>

        <Show when={visibleArtifactCards().length > 0}>
          <div class="mt-4 grid gap-3">
            <For each={visibleArtifactCards()}>
              {(reference) => (
                <FileCard
                  reference={reference}
                  tone={tone()}
                  workspaceRoot={props.workspaceRoot}
                />
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
