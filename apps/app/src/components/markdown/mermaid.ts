import DOMPurify from "dompurify";
import { useEffect, useSyncExternalStore, type RefObject } from "react";
import type { MermaidConfig } from "mermaid";

import {
  getResolvedThemeMode,
  subscribeToTheme,
  type ResolvedThemeMode,
} from "@/app/theme";

export const MERMAID_LIMITS = {
  maxSourceBytes: 50_000,
  maxNodes: 250,
  maxEdges: 400,
  maxStatements: 400,
  maxLines: 800,
  renderTimeoutMs: 5_000,
};

export type MermaidGuardResult =
  | { ok: true }
  | { ok: false; reason: "size" | "complexity" | "unsafe"; message: string };

export type MermaidRuntime = {
  initialize: (config: MermaidConfig) => void;
  render: (id: string, source: string) => Promise<{ svg: string }>;
};

export type MermaidRuntimeLoader = () => Promise<MermaidRuntime>;

export type MermaidRenderResult =
  | { status: "rendered"; svg: string }
  | { status: "source"; reason: "size" | "complexity" | "unsafe" | "invalid" | "timeout" | "unavailable" };

const MERMAID_ARROW_PATTERN = /(?:--!?>|---|-.->|==>|~~~|<--!?>|<==>)/g;
const MERMAID_NODE_DECLARATION_PATTERN = /\b([A-Za-z_][\w-]{0,63})\s*(?=\[|\(\(|\(\[|\{|>)/g;
const MERMAID_PARTICIPANT_PATTERN = /^\s*(?:participant|actor|class|entity|state)\s+([A-Za-z_][\w-]{0,63})\b/gm;
const MERMAID_URL_ATTRIBUTES = new Set([
  "clip-path",
  "cursor",
  "fill",
  "filter",
  "marker-end",
  "marker-mid",
  "marker-start",
  "mask",
  "stroke",
]);
const MERMAID_REDIRECT_ATTRIBUTES = new Set(["href", "src", "xlink:href"]);
const MERMAID_FORBIDDEN_ELEMENTS = "a,foreignObject,image,iframe,object,embed,script,use";
const mermaidSvgByElement = new WeakMap<HTMLElement, string>();

let mermaidRuntimePromise: Promise<MermaidRuntime> | null = null;
let mermaidRenderQueue: Promise<void> = Promise.resolve();
let mermaidRenderId = 0;

export function normalizeCssEscapes(value: string) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\\(?:\r\n|[\n\r\f])/g, "")
    .replace(
      /\\([0-9a-fA-F]{1,6})[ \t\r\n\f]?|\\([^\n\r\f])/g,
      (_match: string, hex: string | undefined, escaped: string | undefined) => {
        if (!hex) return escaped ?? "";
        const codePoint = Number.parseInt(hex, 16);
        if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
          return "\uFFFD";
        }
        return String.fromCodePoint(codePoint);
      },
    );
}

function hasUnsafeMermaidSource(source: string) {
  const normalized = normalizeCssEscapes(source);
  if (/%%\s*\{\s*(?:init|config)\s*:/i.test(normalized)) return true;
  if (/(?:^|[;\n\r])\s*click(?:\s|$)/i.test(normalized)) return true;

  const frontmatter = /^\s*---[^\S\r\n]*(?:\r?\n)([\s\S]*?)(?:\r?\n)---/.exec(normalized);
  if (frontmatter?.[1] && /(?:^|\n)\s*config\s*:/i.test(frontmatter[1])) return true;

  return /(?:javascript|data|blob|file|https?|wss?|ftp)\s*:|\/\/|@import\b|\burl\s*\(|\b(?:href|src|xlink:href)\s*=/i
    .test(normalized);
}

function countMermaidStatements(source: string) {
  let count = 0;
  for (const statement of source.split(/[;\n]/)) {
    const trimmed = statement.trim();
    if (trimmed && !trimmed.startsWith("%%")) count += 1;
  }
  return count;
}

function estimateMermaidNodes(source: string) {
  const nodes = new Set<string>();

  for (const match of source.matchAll(MERMAID_NODE_DECLARATION_PATTERN)) {
    if (match[1]) nodes.add(match[1]);
  }

  for (const match of source.matchAll(MERMAID_PARTICIPANT_PATTERN)) {
    if (match[1]) nodes.add(match[1]);
  }

  for (const line of source.split("\n")) {
    if (!MERMAID_ARROW_PATTERN.test(line)) {
      MERMAID_ARROW_PATTERN.lastIndex = 0;
      continue;
    }
    MERMAID_ARROW_PATTERN.lastIndex = 0;
    const withoutLabels = line.replace(/\[[^\]\n]*\]|\([^\)\n]*\)|\{[^}\n]*\}/g, "");
    const segments = withoutLabels.split(MERMAID_ARROW_PATTERN);
    MERMAID_ARROW_PATTERN.lastIndex = 0;

    for (const segment of segments) {
      const identifiers = segment.match(/[A-Za-z_][\w-]{0,63}/g);
      const identifier = identifiers?.at(-1);
      if (identifier) nodes.add(identifier);
    }
  }

  return nodes.size;
}

export function guardMermaidSource(source: string): MermaidGuardResult {
  if (source.length > MERMAID_LIMITS.maxSourceBytes) {
    return { ok: false, reason: "size", message: "Diagram source is too large to render safely." };
  }
  const sourceBytes = new TextEncoder().encode(source).byteLength;
  if (sourceBytes > MERMAID_LIMITS.maxSourceBytes) {
    return { ok: false, reason: "size", message: "Diagram source is too large to render safely." };
  }

  if (hasUnsafeMermaidSource(source)) {
    return { ok: false, reason: "unsafe", message: "Diagram source contains unsafe directives or resources." };
  }

  const lines = source.split("\n").length;
  const statements = countMermaidStatements(source);
  const edges = source.match(MERMAID_ARROW_PATTERN)?.length ?? 0;
  MERMAID_ARROW_PATTERN.lastIndex = 0;
  const nodes = estimateMermaidNodes(source);
  if (
    lines > MERMAID_LIMITS.maxLines ||
    statements > MERMAID_LIMITS.maxStatements ||
    edges > MERMAID_LIMITS.maxEdges ||
    nodes > MERMAID_LIMITS.maxNodes
  ) {
    return { ok: false, reason: "complexity", message: "Diagram is too complex to render safely." };
  }

  return { ok: true };
}

export function mermaidConfigForTheme(theme: ResolvedThemeMode): MermaidConfig {
  return {
    arrowMarkerAbsolute: false,
    deterministicIds: false,
    flowchart: { htmlLabels: false },
    htmlLabels: false,
    logLevel: "fatal",
    maxEdges: MERMAID_LIMITS.maxEdges,
    maxTextSize: MERMAID_LIMITS.maxSourceBytes,
    secure: [
      "dompurifyConfig",
      "flowchart",
      "htmlLabels",
      "maxEdges",
      "maxTextSize",
      "secure",
      "securityLevel",
      "startOnLoad",
      "theme",
      "themeCSS",
      "themeVariables",
    ],
    securityLevel: "strict",
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: theme === "dark" ? "dark" : "default",
  };
}

export function isSafeMermaidSvgReference(value: string) {
  const normalized = normalizeCssEscapes(value).trim();
  if (!normalized) return true;
  if (/@import|(?:expression|behavior)\s*\(|-moz-binding/i.test(normalized)) return false;
  if (/(?:javascript|data|blob|file|https?|ftp):|(?:^|[\s("'=])\/\//i.test(normalized)) return false;

  for (const match of normalized.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    if (!/^#[A-Za-z_][\w:.-]*$/.test(match[2]?.trim() ?? "")) return false;
  }

  return true;
}

export function sanitizeMermaidSvg(svg: string) {
  if (typeof DOMPurify.sanitize !== "function" || typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") {
    throw new MermaidSanitizerUnavailableError();
  }

  const clean = DOMPurify.sanitize(svg, {
    ALLOW_UNKNOWN_PROTOCOLS: false,
    FORBID_ATTR: ["href", "src", "xlink:href"],
    FORBID_TAGS: ["a", "embed", "foreignObject", "iframe", "image", "object", "script", "use"],
    USE_PROFILES: { svg: true, svgFilters: true },
  });
  const parsed = new DOMParser().parseFromString(clean, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.localName !== "svg" || parsed.querySelector("parsererror")) {
    throw new Error("Mermaid returned invalid SVG.");
  }

  for (const forbidden of Array.from(root.querySelectorAll(MERMAID_FORBIDDEN_ELEMENTS))) {
    forbidden.remove();
  }

  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith("on") ||
        MERMAID_REDIRECT_ATTRIBUTES.has(name) ||
        ((name === "style" || MERMAID_URL_ATTRIBUTES.has(name)) && !isSafeMermaidSvgReference(attribute.value))
      ) {
        element.removeAttribute(attribute.name);
      }
    }

    if (element.localName === "style" && !isSafeMermaidSvgReference(element.textContent ?? "")) {
      element.remove();
    }
  }

  if (!root.hasAttribute("xmlns")) root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return new XMLSerializer().serializeToString(root);
}

class MermaidTimeoutError extends Error {}
class MermaidSanitizerUnavailableError extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new MermaidTimeoutError()), timeoutMs);
    void promise.then(resolve, reject).finally(() => globalThis.clearTimeout(timer));
  });
}

async function loadMermaidRuntime() {
  mermaidRuntimePromise ??= import("mermaid").then((module) => module.default);
  try {
    return await mermaidRuntimePromise;
  } catch (cause) {
    mermaidRuntimePromise = null;
    throw cause;
  }
}

function enqueueMermaidRender<T>(render: () => Promise<T>) {
  const result = mermaidRenderQueue.then(render, render);
  mermaidRenderQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function renderMermaidSource(
  source: string,
  theme: ResolvedThemeMode,
  options: { loadRuntime?: MermaidRuntimeLoader; timeoutMs?: number } = {},
): Promise<MermaidRenderResult> {
  const guard = guardMermaidSource(source);
  if (!guard.ok) return { status: "source", reason: guard.reason };

  const loadRuntime = options.loadRuntime ?? loadMermaidRuntime;
  const timeoutMs = options.timeoutMs ?? MERMAID_LIMITS.renderTimeoutMs;

  return enqueueMermaidRender(async () => {
    let loaded = false;
    try {
      const rendered = await withTimeout((async () => {
        const runtime = await loadRuntime();
        loaded = true;
        runtime.initialize(mermaidConfigForTheme(theme));
        mermaidRenderId += 1;
        return runtime.render(`openwork-mermaid-${mermaidRenderId}`, source);
      })(), timeoutMs);

      return { status: "rendered", svg: sanitizeMermaidSvg(rendered.svg) };
    } catch (cause) {
      if (cause instanceof MermaidTimeoutError) return { status: "source", reason: "timeout" };
      if (cause instanceof MermaidSanitizerUnavailableError || !loaded) return { status: "source", reason: "unavailable" };
      return { status: "source", reason: "invalid" };
    }
  });
}

function sourceStatus(reason: Exclude<MermaidRenderResult, { status: "rendered" }>["reason"]) {
  if (reason === "size") return "Diagram source is too large. Showing source.";
  if (reason === "complexity") return "Diagram is too complex. Showing source.";
  if (reason === "unsafe") return "Diagram contains unsafe directives or resources. Showing source.";
  if (reason === "timeout") return "Diagram rendering timed out. Showing source.";
  if (reason === "unavailable") return "Diagram rendering is unavailable. Showing source.";
  return "Diagram could not be rendered. Showing source.";
}

function setMermaidView(element: HTMLElement, view: "rendered" | "source") {
  const rendered = element.querySelector("[data-openwork-mermaid-rendered]");
  const source = element.querySelector("[data-openwork-mermaid-source]");
  const renderedButton = element.querySelector("[data-openwork-mermaid-view='rendered']");
  const sourceButton = element.querySelector("[data-openwork-mermaid-view='source']");
  if (!(rendered instanceof HTMLElement) || !(source instanceof HTMLElement)) return;

  const showRendered = view === "rendered" && mermaidSvgByElement.has(element);
  rendered.hidden = !showRendered;
  source.hidden = showRendered;
  element.dataset.openworkMermaidState = showRendered ? "rendered" : "source";
  renderedButton?.setAttribute("aria-pressed", String(showRendered));
  sourceButton?.setAttribute("aria-pressed", String(!showRendered));
  renderedButton?.classList.toggle("bg-muted", showRendered);
  renderedButton?.classList.toggle("text-foreground", showRendered);
  sourceButton?.classList.toggle("bg-muted", !showRendered);
  sourceButton?.classList.toggle("text-foreground", !showRendered);
}

async function enhanceMermaidElement(element: HTMLElement, theme: ResolvedThemeMode, signal: AbortSignal) {
  const code = element.querySelector("[data-openwork-mermaid-source] code");
  const renderedPane = element.querySelector("[data-openwork-mermaid-rendered]");
  const renderedButton = element.querySelector("[data-openwork-mermaid-view='rendered']");
  const downloadButton = element.querySelector("[data-openwork-mermaid-download]");
  const status = element.querySelector("[data-openwork-mermaid-status]");
  if (!(code instanceof HTMLElement) || !(renderedPane instanceof HTMLElement)) return;

  element.setAttribute("aria-busy", "true");
  if (status instanceof HTMLElement) {
    status.hidden = false;
    status.textContent = "Rendering diagram…";
  }

  const result = await renderMermaidSource(code.textContent ?? "", theme);
  if (signal.aborted || !element.isConnected) return;
  const preserveSource = mermaidSvgByElement.has(element) && element.dataset.openworkMermaidState === "source";

  element.setAttribute("aria-busy", "false");
  if (result.status === "source") {
    mermaidSvgByElement.delete(element);
    renderedPane.replaceChildren();
    element.dataset.openworkMermaidReason = result.reason;
    if (renderedButton instanceof HTMLButtonElement) renderedButton.disabled = true;
    if (downloadButton instanceof HTMLButtonElement) downloadButton.hidden = true;
    if (status instanceof HTMLElement) status.textContent = sourceStatus(result.reason);
    setMermaidView(element, "source");
    return;
  }

  delete element.dataset.openworkMermaidReason;
  renderedPane.innerHTML = result.svg;
  mermaidSvgByElement.set(element, result.svg);
  element.dataset.openworkMermaidTheme = theme;
  if (renderedButton instanceof HTMLButtonElement) renderedButton.disabled = false;
  if (downloadButton instanceof HTMLButtonElement) downloadButton.hidden = false;
  if (status instanceof HTMLElement) status.hidden = true;
  setMermaidView(element, preserveSource ? "source" : "rendered");
}

export function useMermaidEnhancer(
  rootRef: RefObject<HTMLElement | null>,
  /** Identity of the rendered content; diagrams are re-enhanced when it changes. */
  content: unknown,
  enabled = true,
) {
  const theme = useSyncExternalStore(subscribeToTheme, getResolvedThemeMode, getResolvedThemeMode);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) return;

    const controller = new AbortController();
    const diagrams = Array.from(root.querySelectorAll("[data-openwork-mermaid]"))
      .filter((element): element is HTMLElement => element instanceof HTMLElement);

    const handleClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest("button");
      const diagram = button?.closest("[data-openwork-mermaid]");
      if (!(button instanceof HTMLButtonElement) || !(diagram instanceof HTMLElement)) return;

      const view = button.dataset.openworkMermaidView;
      if (view === "source" || view === "rendered") {
        event.preventDefault();
        setMermaidView(diagram, view);
        return;
      }

      if (!button.hasAttribute("data-openwork-mermaid-download")) return;
      const svg = mermaidSvgByElement.get(diagram);
      if (!svg) return;

      event.preventDefault();
      const index = diagrams.indexOf(diagram) + 1;
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `diagram-${Math.max(1, index)}.svg`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    };

    root.addEventListener("click", handleClick);
    for (const diagram of diagrams) void enhanceMermaidElement(diagram, theme, controller.signal);

    return () => {
      controller.abort();
      root.removeEventListener("click", handleClick);
    };
  }, [content, enabled, rootRef, theme]);
}
