import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { marked } from "marked";
import type { Part } from "@opencode-ai/sdk/v2/client";
import { File } from "lucide-solid";
import { isTauriRuntime, safeStringify, summarizeStep } from "../utils";
import { usePlatform } from "../context/platform";
import { perfNow, recordPerfLog } from "../lib/perf-log";

type Props = {
  part: Part;
  developerMode?: boolean;
  showThinking?: boolean;
  tone?: "light" | "dark";
  workspaceRoot?: string;
  renderMarkdown?: boolean;
  markdownThrottleMs?: number;
  highlightQuery?: string;
};

type LinkType = "url" | "file";

type TextSegment =
  | { kind: "text"; value: string }
  | { kind: "link"; value: string; href: string; type: LinkType };

const WEB_LINK_RE = /^(?:https?:\/\/|www\.)/i;
const FILE_URI_RE = /^file:\/\//i;
const WINDOWS_PATH_RE = /^[A-Za-z]:[\\/][^\s"'`\)\]\}>]+$/;
const POSIX_PATH_RE = /^\/(?!\/)[^\s"'`\)\]\}>][^\s"'`\)\]\}>]*$/;
const TILDE_PATH_RE = /^~\/[^\s"'`\)\]\}>][^\s"'`\)\]\}>]*$/;
const BARE_FILENAME_RE = /^(?!\.)(?!.*\.\.)(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)$/;
const SAFE_PATH_CHAR_RE = /[^\s"'`\)\]\}>]/;

const isRelativeFilePath = (value: string) => {
  if (value === "." || value === "..") return false;

  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const hasNonTraversalSegment = segments.some((segment) => segment && segment !== "." && segment !== "..");

  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    return hasNonTraversalSegment;
  }

  const [firstSegment, secondSegment] = normalized.split("/");
  if (!secondSegment || firstSegment.length <= 1) return false;
  if (secondSegment === "." || secondSegment === "..") return false;
  return firstSegment.startsWith(".") && SAFE_PATH_CHAR_RE.test(secondSegment);
};

const isBareRelativeFilePath = (value: string) => {
  if (value.includes("/") || value.includes("\\") || value.includes(":")) return false;
  if (!BARE_FILENAME_RE.test(value)) return false;

  const extension = value.split(".").pop() ?? "";
  if (!/[A-Za-z]/.test(extension)) return false;

  const dotCount = (value.match(/\./g) ?? []).length;
  if (dotCount === 1 && !value.includes("_") && !value.includes("-")) {
    const [name, tld] = value.split(".");
    if (/^[A-Za-z]{2,24}$/.test(name ?? "") && /^[A-Za-z]{2,10}$/.test(tld ?? "")) {
      return false;
    }
  }

  return true;
};

const LEADING_PUNCTU = /[\"'`\(\[\{<]/;
const TRAILING_PUNCTU = /[\"'`\)\]}>.,:;!?]/;

const isLikelyWebLink = (value: string) => WEB_LINK_RE.test(value);

const isLikelyFilePath = (value: string) => {
  if (FILE_URI_RE.test(value)) return true;
  if (WINDOWS_PATH_RE.test(value)) return true;
  if (POSIX_PATH_RE.test(value)) return true;
  if (TILDE_PATH_RE.test(value)) return true;
  if (isRelativeFilePath(value)) return true;
  if (isBareRelativeFilePath(value)) return true;

  return false;
};

const parseLinkFromToken = (token: string): { href: string; type: LinkType; value: string } | null => {
  let start = 0;
  let end = token.length;

  while (start < end && LEADING_PUNCTU.test(token[start] ?? "")) {
    start += 1;
  }

  while (end > start && TRAILING_PUNCTU.test(token[end - 1] ?? "")) {
    end -= 1;
  }

  const value = token.slice(start, end);
  if (!value) return null;

  if (isLikelyWebLink(value)) {
    return {
      value,
      type: "url",
      href: value.toLowerCase().startsWith("www.") ? `https://${value}` : value,
    };
  }

  if (isLikelyFilePath(value)) {
    return {
      value,
      type: "file",
      href: value,
    };
  }

  return null;
};

const splitTextTokens = (text: string): TextSegment[] => {
  const tokens: TextSegment[] = [];
  const matches = text.matchAll(/\S+/g);
  let position = 0;

  for (const match of matches) {
    const token = match[0] ?? "";
    const index = match.index ?? 0;

    if (index > position) {
      tokens.push({ kind: "text", value: text.slice(position, index) });
    }

    const link = parseLinkFromToken(token);
    if (!link) {
      tokens.push({ kind: "text", value: token });
    } else {
      const start = token.indexOf(link.value);
      if (start > 0) {
        tokens.push({ kind: "text", value: token.slice(0, start) });
      }
      tokens.push({ kind: "link", value: link.value, href: link.href, type: link.type });
      const end = start + link.value.length;
      if (end < token.length) {
        tokens.push({ kind: "text", value: token.slice(end) });
      }
    }

    position = index + token.length;
  }

  if (position < text.length) {
    tokens.push({ kind: "text", value: text.slice(position) });
  }

  return tokens;
};

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const renderInlineTextWithLinks = (text: string) => {
  const tokens = splitTextTokens(text);
  return tokens
    .map((token) => {
      if (token.kind === "text") return escapeHtml(token.value);
      return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer" class="underline underline-offset-2 text-dls-accent hover:text-[var(--dls-accent-hover)]">${escapeHtml(token.value)}</a>`;
    })
    .join("");
};

const normalizeRelativePath = (relativePath: string, workspaceRoot: string) => {
  const root = workspaceRoot.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!root) return null;

  const relative = relativePath.trim().replace(/\\/g, "/");
  if (!relative) return null;

  const isPosixRoot = root.startsWith("/");
  const rootValue = isPosixRoot ? root.slice(1) : root;
  const rootParts = rootValue.split("/").filter((value) => value.length > 0);
  const isWindowsDrive = /^[A-Za-z]:$/.test(rootParts[0] ?? "");
  const resolved: string[] = [...rootParts];
  const segments = relative.split("/");

  for (const segment of segments) {
    if (!segment || segment === ".") continue;

    if (segment === "..") {
      if (!(isWindowsDrive && resolved.length === 1)) {
        resolved.pop();
      }
      continue;
    }

    resolved.push(segment);
  }

  const normalized = resolved.join("/");
  if (isPosixRoot) return `/${normalized || ""}` || "/";
  return normalized;
};

const normalizeFilePath = (href: string, workspaceRoot: string): string | null => {
  if (FILE_URI_RE.test(href)) {
    try {
      const parsed = new URL(href);
      if (parsed.protocol !== "file:") return null;
      const raw = decodeURIComponent(parsed.pathname || "");
      if (!raw) return null;
      if (/^\/[A-Za-z]:\//.test(raw)) {
        return raw.slice(1);
      }
      if (parsed.hostname && !parsed.pathname.startsWith(`/${parsed.hostname}`) && !raw.startsWith("/")) {
        return `/${parsed.hostname}${raw}`;
      }
      return raw;
    } catch {
      const raw = decodeURIComponent(href.replace(/^file:\/\//, ""));
      if (!raw) return null;
      return raw;
    }
  }

  const trimmed = href.trim();
  if (isRelativeFilePath(trimmed) || isBareRelativeFilePath(trimmed)) {
    if (!workspaceRoot) return null;
    return normalizeRelativePath(trimmed, workspaceRoot);
  }

  return href;
};

function clampText(text: string, max = 800) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n… (truncated)`;
}

const SEARCH_HIGHLIGHT_MARK_ATTR = "data-search-highlight";

const clearTextHighlights = (root: HTMLElement) => {
  const marks = root.querySelectorAll(`mark[${SEARCH_HIGHLIGHT_MARK_ATTR}="true"]`);
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
  });
  root.normalize();
};

const applyTextHighlights = (root: HTMLElement, query: string) => {
  clearTextHighlights(root);
  const needle = query.trim().toLowerCase();
  if (!needle) return;

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const value = node.nodeValue ?? "";
        if (!value.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest("pre, code")) return NodeFilter.FILTER_REJECT;
        if (parent.tagName === "SCRIPT" || parent.tagName === "STYLE") return NodeFilter.FILTER_REJECT;
        return value.toLowerCase().includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    },
  );

  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }

  nodes.forEach((node) => {
    const text = node.nodeValue ?? "";
    const lower = text.toLowerCase();
    let searchIndex = 0;
    const fragment = document.createDocumentFragment();

    while (searchIndex < text.length) {
      const matchIndex = lower.indexOf(needle, searchIndex);
      if (matchIndex === -1) {
        fragment.appendChild(document.createTextNode(text.slice(searchIndex)));
        break;
      }

      if (matchIndex > searchIndex) {
        fragment.appendChild(document.createTextNode(text.slice(searchIndex, matchIndex)));
      }

      const mark = document.createElement("mark");
      mark.setAttribute(SEARCH_HIGHLIGHT_MARK_ATTR, "true");
      mark.className = "rounded px-0.5 bg-amber-4/70 text-current";
      mark.textContent = text.slice(matchIndex, matchIndex + needle.length);
      fragment.appendChild(mark);
      searchIndex = matchIndex + needle.length;
    }

    node.parentNode?.replaceChild(fragment, node);
  });
};

function useThrottledValue<T>(value: () => T, delayMs: number | (() => number) = 80) {
  const [state, setState] = createSignal<T>(value());
  let timer: ReturnType<typeof setTimeout> | undefined;

  createEffect(() => {
    const next = value();
    const delay = typeof delayMs === "function" ? delayMs() : delayMs;
    if (!delay) {
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

function createCustomRenderer(tone: "light" | "dark") {
  const renderer = new marked.Renderer();
  const codeBlockClass =
    tone === "dark"
      ? "bg-gray-12/10 border-gray-11/20 text-gray-12"
      : "bg-gray-1/80 border-gray-6/70 text-gray-12";
  const inlineCodeClass =
    tone === "dark"
      ? "bg-gray-12/15 text-gray-12"
      : "bg-gray-2/70 text-gray-12";
  
  const isSafeUrl = (url: string) => {
    const normalized = (url || "").trim().toLowerCase();
    if (normalized.startsWith("javascript:")) return false;
    // Allow data:image/* URIs (base64-encoded images from AI models) but block
    // other data: schemes (e.g. data:text/html) which could be used for XSS.
    if (normalized.startsWith("data:")) return normalized.startsWith("data:image/");
    return true;
  };

  renderer.html = ({ text }) => escapeHtml(text);

  renderer.text = ({ text }) => renderInlineTextWithLinks(text);

  renderer.code = ({ text, lang }) => {
    const language = lang || "";
    return `
      <div class="rounded-2xl border px-4 py-3 my-4 ${codeBlockClass}">
        ${
          language
            ? `<div class="text-[10px] uppercase tracking-[0.2em] text-gray-9 mb-2">${escapeHtml(language)}</div>`
            : ""
        }
        <pre class="overflow-x-auto whitespace-pre text-[13px] leading-relaxed font-mono"><code>${escapeHtml(
          text
        )}</code></pre>
      </div>
    `;
  };

  renderer.codespan = ({ text }) => {
    return `<code class="rounded-md px-1.5 py-0.5 text-[13px] font-mono ${inlineCodeClass}">${escapeHtml(
      text
    )}</code>`;
  };

  renderer.link = ({ href, title, text }) => {
    const safeHref = isSafeUrl(href) ? escapeHtml(href ?? "#") : "#";
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
    const safeHref = isSafeUrl(href) ? escapeHtml(href ?? "") : "";
    const safeTitle = title ? escapeHtml(title) : "";
    return `
      <img
        src="${safeHref}"
        alt="${escapeHtml(text || "")}"
        ${safeTitle ? `title="${safeTitle}"` : ""}
        class="max-w-full h-auto rounded-lg my-4"
      />
    `;
  };

  return renderer;
}

export default function PartView(props: Props) {
  const platform = usePlatform();
  const p = () => props.part;
  const developerMode = () => props.developerMode ?? false;
  const tone = () => props.tone ?? "light";
  const showThinking = () => props.showThinking ?? true;
  const renderMarkdown = () => props.renderMarkdown ?? false;
  const markdownThrottleMs = () => Math.max(0, props.markdownThrottleMs ?? 100);
  let textContainerEl: HTMLDivElement | undefined;
  const fileInfo = () => {
    if (p().type !== "file") return null;
    const part = p() as {
      filename?: string;
      url?: string;
      mime?: string;
      source?: {
        type?: string;
        path?: string;
        name?: string;
        clientName?: string;
        uri?: string;
      };
    };
    const source = part.source ?? {};
    const sourceType = typeof source.type === "string" ? source.type : "";
    const sourcePath = typeof source.path === "string" ? source.path : "";
    const sourceName = typeof source.name === "string" ? source.name : "";
    const sourceClient = typeof source.clientName === "string" ? source.clientName : "";
    const sourceUri = typeof source.uri === "string" ? source.uri : "";
    const filename = typeof part.filename === "string" ? part.filename : "";
    const url = typeof part.url === "string" ? part.url : "";
    const pathName = sourcePath ? sourcePath.split(/[\\/]/).pop() ?? sourcePath : "";
    const title = filename || pathName || sourceName || url || "File";
    const detail = (() => {
      if (sourceType === "symbol") {
        if (sourcePath) return `${sourceName || "symbol"} - ${sourcePath}`;
        return sourceName || "";
      }
      if (sourceType === "resource") {
        const details = [sourceClient, sourceUri].filter(Boolean).join(" - ");
        return details || url;
      }
      return sourcePath || url;
    })();
    const mime = typeof part.mime === "string" ? part.mime : "";
    return { title, detail, mime };
  };

  const textClass = () => (tone() === "dark" ? "text-gray-12" : "text-gray-12");
  const subtleTextClass = () => (tone() === "dark" ? "text-gray-12/70" : "text-gray-11");
  const panelBgClass = () => (tone() === "dark" ? "bg-gray-2/10" : "bg-gray-2/30");
  const toolOnly = () => true;
  const showToolOutput = () => developerMode();
  const markdownSource = createMemo(() => {
    if (!renderMarkdown() || p().type !== "text") return "";
    return "text" in p() ? String((p() as { text: string }).text ?? "") : "";
  });
  const throttledMarkdownSource = useThrottledValue(markdownSource, markdownThrottleMs);
  const renderedMarkdown = createMemo(() => {
    if (!renderMarkdown() || p().type !== "text") return null;
    const text = throttledMarkdownSource();
    if (!text.trim()) return "";
    
    try {
      const startedAt = perfNow();
      const renderer = createCustomRenderer(tone());
      const result = marked.parse(text, { 
        breaks: true, 
        gfm: true,
        renderer,
        async: false
      });
      const parseMs = Math.round((perfNow() - startedAt) * 100) / 100;
      if (developerMode() && (parseMs >= 12 || text.length >= 6_000)) {
        const record = p() as { id?: string; messageID?: string };
        recordPerfLog(true, "session.render", "markdown-parse", {
          partID: record.id ?? null,
          messageID: record.messageID ?? null,
          chars: text.length,
          ms: parseMs,
        });
      }
      
      return typeof result === 'string' ? result : '';
    } catch (error) {
      console.error('Markdown parsing error:', error);
      return null;
    }
  });

  const openLink = async (href: string, type: LinkType) => {
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

    try {
      const { openPath, revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(filePath).catch(() => openPath(filePath));
    } catch {
      platform.openLink(href.startsWith("file://") ? href : `file://${filePath}`);
    }
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
    const text = "text" in p() ? String((p() as { text: string }).text) : "";
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
    if (p().type !== "text") return;
    const root = textContainerEl;
    if (!root) return;
    const query = props.highlightQuery ?? "";
    const markdownSnapshot = renderMarkdown() ? renderedMarkdown() : null;
    queueMicrotask(() => {
      if (!textContainerEl || textContainerEl !== root) return;
      applyTextHighlights(textContainerEl, query);
    });
    void markdownSnapshot;
  });

  const toolData = () => {
    if (p().type !== "tool") return null;
    return p() as any;
  };

  let toolSummaryRuns = 0;
  let lastToolSummaryAt = 0;
  const toolSummary = createMemo(() => {
    if (p().type !== "tool") return null;
    const startedAt = perfNow();
    const summary = summarizeStep(p());
    const elapsedMs = Math.round((perfNow() - startedAt) * 100) / 100;
    toolSummaryRuns += 1;
    const now = Date.now();
    const sinceLastMs = lastToolSummaryAt > 0 ? now - lastToolSummaryAt : null;
    lastToolSummaryAt = now;

    if (developerMode() && (elapsedMs >= 4 || (toolSummaryRuns >= 6 && (sinceLastMs ?? 0) < 300))) {
      const record = p() as { id?: string; messageID?: string };
      recordPerfLog(true, "session.render", "tool-summary", {
        partID: record.id ?? null,
        messageID: record.messageID ?? null,
        runs: toolSummaryRuns,
        sinceLastMs,
        ms: elapsedMs,
      });
    }

    return summary;
  });
  const toolState = () => toolData()?.state ?? {};
  const toolName = () => (toolData()?.tool ? String(toolData()?.tool) : "tool");
  const toolTitle = () => {
    const title = toolSummary()?.title;
    if (title) return title;
    return toolState()?.title ? String(toolState().title) : toolName();
  };
  const toolStatus = () => (toolState()?.status ? String(toolState().status) : "unknown");
  const toolSubtitle = () => {
    const detail = toolSummary()?.detail;
    if (detail) return detail;
    if (toolState()?.subtitle || toolState()?.detail || toolState()?.summary) {
      return String(toolState().subtitle ?? toolState().detail ?? toolState().summary);
    }
    return "";
  };

  const extractDiff = () => {
    const state = toolState();
    const candidates = [state?.diff, state?.patch, state?.output];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      if (candidate.includes("@@") || candidate.includes("+++ ") || candidate.includes("--- ")) {
        return candidate;
      }
    }
    return null;
  };

  const diffText = createMemo(() => (p().type === "tool" ? extractDiff() : null));
  const normalizeToolText = (value: unknown) => {
    if (typeof value !== "string") return "";
    return value.replace(/(?:\r?\n\s*)+$/, "");
  };
  const diffTextNormalized = createMemo(() => normalizeToolText(diffText()));
  const diffLines = createMemo(() => (diffTextNormalized() ? diffTextNormalized().split("\n") : []));
  const diffLineClass = (line: string) => {
    if (line.startsWith("+")) return "text-green-11 bg-green-1/40";
    if (line.startsWith("-")) return "text-red-11 bg-red-1/40";
    if (line.startsWith("@@")) return "text-blue-11 bg-blue-1/30";
    return "text-gray-12";
  };

  const toolOutput = () => normalizeToolText(toolState()?.output);
  const hasReadXmlOutput = createMemo(() => {
    if (toolName().toLowerCase() !== "read") return false;
    const output = toolOutput().trimStart();
    return output.startsWith("<path>") || output.startsWith("<type>") || output.startsWith("<content>");
  });

  const toolError = () => {
    const error = toolState()?.error;
    return typeof error === "string" ? error : null;
  };

  const toolInput = () => toolState()?.input;

  const diagnostics = () => {
    const items = toolState()?.diagnostics;
    return Array.isArray(items) ? items : [];
  };

  const formatDiagnosticLocation = (diagnostic: any) => {
    const raw = diagnostic?.file ?? diagnostic?.path ?? diagnostic?.uri ?? "";
    const file = typeof raw === "string" ? raw.replace(/^file:\/\//, "") : "";
    const line = diagnostic?.line ?? diagnostic?.range?.start?.line;
    const character = diagnostic?.character ?? diagnostic?.range?.start?.character;
    const location =
      typeof line === "number"
        ? `${line + 1}${typeof character === "number" ? `:${character + 1}` : ""}`
        : "";
    return `${file}${file && location ? ":" : ""}${location}`.trim();
  };

  const formatDiagnosticLabel = (diagnostic: any) => {
    const severity = diagnostic?.severity ?? diagnostic?.level;
    if (typeof severity === "string") return severity;
    if (severity === 1) return "error";
    if (severity === 2) return "warning";
    if (severity === 3) return "info";
    if (severity === 4) return "hint";
    return "diagnostic";
  };

  const isLargeOutput = createMemo(() => toolOutput().length > 800);

  const [expandedOutput, setExpandedOutput] = createSignal(false);
  const outputPreview = createMemo(() => {
    const output = toolOutput();
    if (!output) return "";
    if (isLargeOutput() && !expandedOutput()) {
      return `${output.slice(0, 800)}\n\n… (truncated)`;
    }
    return output;
  });

  const toolImages = () => {
    const state = toolState();
    const candidates = Array.isArray(state?.images) ? state.images : [];
    return candidates
      .map((item: any) => {
        if (typeof item === "string") return { src: item, alt: "" };
        const src = item?.url ?? item?.src ?? item?.data;
        if (!src) return null;
        if (item?.data && item?.mediaType && !String(item.data).startsWith("data:")) {
          return { src: `data:${item.mediaType};base64,${item.data}`, alt: item?.alt ?? "" };
        }
        return { src, alt: item?.alt ?? "" };
      })
      .filter(Boolean);
  };

  const inlineImage = () => {
    if (p().type !== "file") return null;
    const record = p() as any;
    const mime = typeof record?.mime === "string" ? record.mime : "";
    if (!mime.startsWith("image/")) return null;
    const src = record?.url ?? record?.src ?? record?.data ?? record?.source;
    if (!src) return null;
    if (record?.data && record?.mediaType && !String(record.data).startsWith("data:")) {
      return `data:${record.mediaType};base64,${record.data}`;
    }
    return src as string;
  };

  return (
    <Switch>
      <Match when={p().type === "text"}>
        <Show
          when={renderMarkdown()}
          fallback={
            <div
              ref={(el) => {
                textContainerEl = el;
              }}
              class={`whitespace-pre-wrap break-words ${textClass()}`.trim()}
            >
              {renderTextWithLinks()}
            </div>
          }
        >
          <Show
            when={renderedMarkdown()}
            fallback={
              <div
                ref={(el) => {
                  textContainerEl = el;
                }}
                class={`whitespace-pre-wrap break-words ${textClass()}`.trim()}
              >
                {renderTextWithLinks()}
              </div>
            }
          >
            <div
              ref={(el) => {
                textContainerEl = el;
              }}
              class={`markdown-content max-w-none ${textClass()}
                [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:my-4
                [&_h2]:text-xl [&_h2]:font-bold [&_h2]:my-3
                [&_h3]:text-lg [&_h3]:font-bold [&_h3]:my-2
                [&_p]:my-3 [&_p]:leading-relaxed
                [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-3
                [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-3
                [&_li]:my-1
                [&_blockquote]:border-l-4 [&_blockquote]:border-dls-border [&_blockquote]:pl-4 [&_blockquote]:my-4 [&_blockquote]:italic
                [&_table]:w-full [&_table]:border-collapse [&_table]:my-4
                [&_th]:border [&_th]:border-dls-border [&_th]:p-2 [&_th]:bg-dls-hover
                [&_td]:border [&_td]:border-dls-border [&_td]:p-2
              `.trim()}
              innerHTML={renderedMarkdown()!}
              onClick={openMarkdownLink}
            />
          </Show>
        </Show>
      </Match>

      <Match when={p().type === "file"}>
        <Show when={fileInfo()}>
          {(info) => (
            <div
              class={`flex items-center gap-3 rounded-xl border px-3 py-2 ${
                tone() === "dark" ? "border-gray-6 bg-gray-1/60" : "border-gray-6/70 bg-gray-2/40"
              }`.trim()}
            >
              <div
                class={`h-9 w-9 rounded-lg flex items-center justify-center ${
                  tone() === "dark" ? "bg-gray-12/10 text-gray-12" : "bg-gray-2/70 text-gray-11"
                }`.trim()}
              >
                <File size={16} />
              </div>
              <div class="min-w-0 flex-1">
                <div class={`text-sm font-medium truncate ${textClass()}`.trim()}>{info().title}</div>
                <Show when={info().detail}>
                  <div class={`text-[11px] truncate ${subtleTextClass()}`.trim()}>{info().detail}</div>
                </Show>
              </div>
              <Show when={info().mime}>
                <div
                  class={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full max-w-[160px] truncate ${
                    tone() === "dark"
                      ? "bg-gray-12/10 text-gray-12/80"
                      : "bg-gray-1/70 text-gray-9"
                  }`.trim()}
                >
                  {info().mime}
                </div>
              </Show>
            </div>
          )}
        </Show>
      </Match>

      <Match when={p().type === "reasoning"}>
        <Show
          when={
            showThinking() &&
            developerMode() &&
            "text" in p() &&
            typeof (p() as { text: string }).text === "string" &&
            (p() as { text: string }).text.trim()
          }
        >
          <details class={`rounded-lg ${panelBgClass()} p-2`.trim()}>
            <summary class={`cursor-pointer text-xs ${subtleTextClass()}`.trim()}>Thinking</summary>
            <pre class={`mt-2 whitespace-pre-wrap break-words text-xs text-gray-12`.trim()}>
              {clampText(String((p() as { text: string }).text), 2000)}
            </pre>
          </details>
        </Show>
      </Match>

      <Match when={p().type === "tool"}>
        <Show when={toolOnly()}>
          <div class="grid gap-3">
            <div class="flex items-start justify-between gap-3">
              <div class="space-y-1">
                <div class={`text-xs font-medium text-gray-12`.trim()}>
                  {toolTitle()}
                </div>
                <div class={`text-[11px] ${subtleTextClass()}`.trim()}>{toolName()}</div>
              </div>
              <div
                class={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  toolStatus() === "completed"
                    ? "bg-green-3/15 text-green-12"
                    : toolStatus() === "running"
                      ? "bg-blue-3/15 text-blue-12"
                      : toolStatus() === "error"
                        ? "bg-red-3/15 text-red-12"
                        : "bg-gray-2/10 text-gray-12"
                }`}
              >
                {toolStatus()}
              </div>
            </div>

            <Show when={toolSubtitle()}>
              <div class={`text-xs ${subtleTextClass()}`.trim()}>{toolSubtitle()}</div>
            </Show>

            <Show when={diagnostics().length > 0}>
              <div class={`rounded-lg border ${panelBgClass()} p-2`.trim()}>
                <div class={`text-[11px] font-medium ${subtleTextClass()}`.trim()}>Diagnostics</div>
                <div class="mt-2 grid gap-2">
                  <For each={diagnostics()}>
                    {(diag: any) => (
                      <div class="flex items-start justify-between gap-4 text-xs">
                        <div>
                          <div class="font-medium text-gray-12">{String(diag?.message ?? "")}</div>
                          <Show when={diag?.source || diag?.code}>
                            <div class="text-[11px] text-gray-10">
                              {[diag?.source, diag?.code].filter(Boolean).join(" · ")}
                            </div>
                          </Show>
                        </div>
                        <div class="text-[11px] text-gray-10 text-right">
                          <div>{formatDiagnosticLabel(diag)}</div>
                          <Show when={formatDiagnosticLocation(diag)}>
                            <div>{formatDiagnosticLocation(diag)}</div>
                          </Show>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            <Show when={diffText()}>
              <div class={`rounded-lg border ${panelBgClass()} p-2`.trim()}>
                <div class={`text-[11px] font-medium ${subtleTextClass()}`.trim()}>Diff</div>
                <div class="mt-2 grid gap-1 rounded-md overflow-hidden">
                  <For each={diffLines()}>
                    {(line) => (
                      <div
                        class={`font-mono text-[11px] leading-relaxed px-2 py-0.5 whitespace-pre-wrap break-words ${diffLineClass(
                          line,
                        )}`.trim()}
                      >
                        {line || " "}
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            <Show when={toolImages().length > 0}>
              <div class="grid gap-2">
                <For each={toolImages()}>
                  {(image: any) => (
                    <img
                      src={image.src}
                      alt={image.alt || ""}
                      class="max-w-full h-auto rounded-lg border border-gray-6/50"
                    />
                  )}
                </For>
              </div>
            </Show>

            <Show when={toolError()}>
              <div class="rounded-lg bg-red-1/40 p-2 text-xs text-red-12">
                {toolError()}
              </div>
            </Show>

            <Show when={showToolOutput() && toolOutput() && toolOutput() !== diffTextNormalized() && !hasReadXmlOutput()}>
              <pre
                class={`whitespace-pre-wrap break-words rounded-lg ${panelBgClass()} p-2 text-xs text-gray-12`.trim()}
              >
                {outputPreview()}
              </pre>
            </Show>

            <Show when={showToolOutput() && hasReadXmlOutput()}>
              <details class={`rounded-lg ${panelBgClass()} p-2`.trim()}>
                <summary class={`cursor-pointer text-xs ${subtleTextClass()}`.trim()}>Raw read output</summary>
                <pre class={`mt-2 whitespace-pre-wrap break-words text-xs text-gray-12`.trim()}>
                  {outputPreview()}
                </pre>
              </details>
            </Show>

            <Show when={showToolOutput() && isLargeOutput()}>
              <button
                class={`text-[11px] ${subtleTextClass()} hover:text-gray-12 transition-colors`}
                onClick={() => setExpandedOutput((current) => !current)}
              >
                {expandedOutput() ? "Show less" : "Show more"}
              </button>
            </Show>

            <Show when={showToolOutput() && toolInput() != null}>
              <details class={`rounded-lg ${panelBgClass()} p-2`.trim()}>
                <summary class={`cursor-pointer text-xs ${subtleTextClass()}`.trim()}>Input</summary>
                <pre class={`mt-2 whitespace-pre-wrap break-words text-xs text-gray-12`.trim()}>
                  {safeStringify(toolInput())}
                </pre>
              </details>
            </Show>
          </div>
        </Show>
      </Match>

      <Match when={inlineImage()}>
        <img
          src={inlineImage()!}
          alt=""
          class="max-w-full h-auto rounded-xl border border-gray-6/50"
        />
      </Match>

      <Match when={p().type === "step-start" || p().type === "step-finish"}>
        <div class={`text-xs ${subtleTextClass()}`.trim()}>
          {p().type === "step-start" ? "Step started" : "Step finished"}
          <Show when={"reason" in p() && (p() as any).reason}>
            <span class={tone() === "dark" ? "text-gray-12/80" : "text-gray-11"}>
              {" "}· {String((p() as any).reason)}
            </span>
          </Show>
        </div>
      </Match>

      <Match when={true}>
        <Show when={developerMode()}>
          <pre class={`whitespace-pre-wrap break-words text-xs text-gray-12`.trim()}>
            {safeStringify(p())}
          </pre>
        </Show>
      </Match>
    </Switch>
  );
}
