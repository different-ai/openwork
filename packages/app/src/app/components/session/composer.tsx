import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Agent } from "@opencode-ai/sdk/v2/client";
import fuzzysort from "fuzzysort";
import { ArrowUp, AtSign, Check, ChevronDown, File as FileIcon, Paperclip, Square, Terminal, X, Zap } from "lucide-solid";

import type { ComposerAttachment, ComposerDraft, ComposerPart, PromptMode, SlashCommandOption } from "../../types";
import { perfNow, recordPerfLog } from "../../lib/perf-log";

type MentionOption = {
  id: string;
  kind: "agent" | "file";
  label: string;
  value: string;
  display: string;
  recent?: boolean;
};

type MentionGroup = {
  category: "agent" | "recent" | "file";
  items: MentionOption[];
};

type ComposerProps = {
  prompt: string;
  developerMode: boolean;
  busy: boolean;
  isStreaming: boolean;
  onSend: (draft: ComposerDraft) => void;
  onStop: () => void;
  onDraftChange: (draft: ComposerDraft) => void;
  selectedModelLabel: string;
  onModelClick: () => void;
  modelVariantLabel: string;
  modelVariant: string | null;
  onModelVariantChange: (value: string) => void;
  agentLabel: string;
  selectedAgent: string | null;
  agentPickerOpen: boolean;
  agentPickerBusy: boolean;
  agentPickerError: string | null;
  agentOptions: Agent[];
  onToggleAgentPicker: () => void;
  onSelectAgent: (agent: string | null) => void;
  setAgentPickerRef: (el: HTMLDivElement) => void;
  showNotionBanner: boolean;
  onNotionBannerClick: () => void;
  toast: string | null;
  onToast: (message: string) => void;
  listAgents: () => Promise<Agent[]>;
  recentFiles: string[];
  searchFiles: (query: string) => Promise<string[]>;
  isRemoteWorkspace: boolean;
  isSandboxWorkspace: boolean;
  onUploadInboxFiles?: (
    files: File[],
    options?: { notify?: boolean },
  ) => void | Promise<Array<{ name: string; path: string }> | void>;
  attachmentsEnabled: boolean;
  attachmentsDisabledReason: string | null;
  listCommands: () => Promise<SlashCommandOption[]>;
};

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const IMAGE_COMPRESS_MAX_PX = 2048;
const IMAGE_COMPRESS_QUALITY = 0.82;
const IMAGE_COMPRESS_TARGET_BYTES = 1_500_000;
const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const ACCEPTED_FILE_TYPES = [...ACCEPTED_IMAGE_TYPES, "application/pdf"];
const FILE_URL_RE = /^file:\/\//i;
const HTTP_URL_RE = /^https?:\/\//i;
const WINDOWS_PATH_RE = /^[a-zA-Z]:\\/;
const UNC_PATH_RE = /^\\\\/;

const isImageMime = (mime: string) => ACCEPTED_IMAGE_TYPES.includes(mime);
const isSupportedAttachmentType = (mime: string) => ACCEPTED_FILE_TYPES.includes(mime);

const escapeMarkdownLabel = (value: string) =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");

const normalizeLinkTarget = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (FILE_URL_RE.test(trimmed) || HTTP_URL_RE.test(trimmed)) {
    return encodeURI(trimmed);
  }
  if (WINDOWS_PATH_RE.test(trimmed)) {
    return `file:///${encodeURI(trimmed.replace(/\\/g, "/"))}`;
  }
  if (UNC_PATH_RE.test(trimmed)) {
    const normalized = trimmed.replace(/\\/g, "/").replace(/^\/+/, "");
    return `file://${encodeURI(normalized)}`;
  }
  if (trimmed.startsWith("/")) {
    return `file://${encodeURI(trimmed)}`;
  }
  return "";
};

const parseClipboardLinks = (clipboard: DataTransfer) => {
  const values = [
    clipboard.getData("text/uri-list") ?? "",
    clipboard.getData("text/plain") ?? "",
    clipboard.getData("text") ?? "",
  ];
  const links: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const lines = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    for (const line of lines) {
      const target = normalizeLinkTarget(line);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      links.push(target);
    }
  }
  return links;
};

const inboxPathToLink = (path: string) => {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (!normalized) return "";
  if (normalized.startsWith(".opencode/openwork/inbox/")) {
    return normalized;
  }
  return `.opencode/openwork/inbox/${normalized}`;
};

const formatLinks = (links: Array<{ name: string; target: string }>) =>
  links
    .filter((entry) => entry.target)
    .map((entry) => `[${escapeMarkdownLabel(entry.name || "file")}](${entry.target})`)
    .join("\n");

const fileToDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read attachment"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result);
    };
    reader.readAsDataURL(file);
  });

/**
 * Compress an image file to JPEG using OffscreenCanvas (off main thread when possible).
 * Falls back to regular canvas if OffscreenCanvas is unavailable.
 * Returns a new File with compressed data, or the original if compression isn't beneficial.
 */
const compressImageFile = async (file: File): Promise<File> => {
  // Skip GIFs (animated) and already-small images
  if (file.type === "image/gif" || file.size <= IMAGE_COMPRESS_TARGET_BYTES) {
    return file;
  }

  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;

  // Calculate scaled dimensions
  const maxDim = Math.max(width, height);
  const scale = maxDim > IMAGE_COMPRESS_MAX_PX ? IMAGE_COMPRESS_MAX_PX / maxDim : 1;
  const targetW = Math.round(width * scale);
  const targetH = Math.round(height * scale);

  let blob: Blob | null = null;

  if (typeof OffscreenCanvas !== "undefined") {
    const offscreen = new OffscreenCanvas(targetW, targetH);
    const ctx = offscreen.getContext("2d");
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
      blob = await offscreen.convertToBlob({ type: "image/jpeg", quality: IMAGE_COMPRESS_QUALITY });
    }
  }

  if (!blob) {
    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", IMAGE_COMPRESS_QUALITY),
    );
  }

  bitmap.close();

  if (!blob || blob.size >= file.size) {
    return file; // Compression didn't help
  }

  const ext = file.name.replace(/\.[^.]+$/, "");
  return new File([blob], `${ext || "image"}.jpg`, { type: "image/jpeg" });
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const normalizeText = (value: string) => value.replace(/\u00a0/g, " ");
const RECENT_EMIT_TTL_MS = 30_000;
const MAX_RECENT_EMITS = 400;
const DRAFT_FLUSH_DEBOUNCE_MS = 140;

const MODEL_VARIANT_OPTIONS = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "X-High" },
];

const partsToText = (parts: ComposerPart[]) =>
  parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "agent") return `@${part.name}`;
      if (part.type === "file") return `@${part.path}`;
      return part.label;
    })
    .join("");

const partsToResolvedText = (parts: ComposerPart[]) =>
  parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "agent") return `@${part.name}`;
      if (part.type === "file") return `@${part.path}`;
      return part.text;
    })
    .join("");

const createMentionSpan = (part: Extract<ComposerPart, { type: "agent" | "file" }>) => {
  const span = document.createElement("span");
  const label = part.type === "agent" ? part.name : part.path;
  span.textContent = `@${label}`;
  span.contentEditable = "false";
  span.dataset.mentionKind = part.type;
  span.dataset.mentionValue = part.type === "agent" ? part.name : part.path;
  span.dataset.mentionLabel = label;
  span.className =
    "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-dls-active text-dls-text border border-dls-border";
  return span;
};

const createSlashSpan = (cmd: SlashCommandOption) => {
  const span = document.createElement("span");
  span.textContent = `/${cmd.name}`;
  span.contentEditable = "false";
  span.dataset.slashCommand = cmd.name;
  span.dataset.slashSource = cmd.source ?? "command";
  span.title = cmd.source ? `${cmd.source} command` : "command";

  const tone =
    cmd.source === "skill"
      ? "bg-indigo-3/20 text-indigo-11 border-indigo-7/30"
      : cmd.source === "mcp"
        ? "bg-purple-3/15 text-purple-11 border-purple-7/30"
        : "bg-blue-3/15 text-blue-11 border-blue-7/30";

  span.className = `inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold border ${tone}`;
  return span;
};

const insertTextWithBreaks = (target: HTMLElement, text: string) => {
  const chunks = text.split("\n");
  chunks.forEach((chunk, index) => {
    if (chunk.length) {
      target.appendChild(document.createTextNode(chunk));
    }
    if (index < chunks.length - 1) {
      target.appendChild(document.createElement("br"));
    }
  });
};

const sanitizePastedPlainText = (value: string) => normalizeText(value).replace(/\r\n?/g, "\n");

const htmlToPlainText = (html: string) => {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.innerText ?? "";
};

const countLines = (value: string) => (value ? value.split("\n").length : 0);

const textToFragment = (text: string) => {
  const frag = document.createDocumentFragment();
  const chunks = text.split("\n");
  chunks.forEach((chunk, index) => {
    if (chunk.length) frag.appendChild(document.createTextNode(chunk));
    if (index < chunks.length - 1) frag.appendChild(document.createElement("br"));
  });
  return frag;
};

const buildPartsFromEditor = (root: HTMLElement, pasteTextById?: Map<string, string>): ComposerPart[] => {
  const parts: ComposerPart[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last?.type === "text") {
      last.text += text;
      return;
    }
    parts.push({ type: "text", text });
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.dataset.mentionKind) {
      const kind = el.dataset.mentionKind === "agent" ? "agent" : "file";
      if (kind === "agent") {
        parts.push({ type: "agent", name: el.dataset.mentionValue ?? "" });
      } else {
        parts.push({ type: "file", path: el.dataset.mentionValue ?? "", label: el.dataset.mentionLabel ?? undefined });
      }
      return;
    }
    if (el.dataset.pasteId) {
      const id = el.dataset.pasteId ?? "";
      const label = el.dataset.pasteLabel ?? el.textContent ?? "[pasted text]";
      const lines = Number(el.dataset.pasteLines ?? "0") || 0;
      const text = pasteTextById?.get(id) ?? label;
      parts.push({ type: "paste", id, label, text, lines });
      return;
    }
    if (el.tagName === "BR") {
      pushText("\n");
      return;
    }
    if (el.tagName === "DIV") {
      if (!el.childNodes.length) {
        pushText("\n");
        return;
      }
      el.childNodes.forEach(walk);
      pushText("\n");
      return;
    }
    el.childNodes.forEach(walk);
  };

  root.childNodes.forEach(walk);
  return parts;
};

const getSelectionOffsets = (root: HTMLElement) => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const startRange = range.cloneRange();
  startRange.selectNodeContents(root);
  startRange.setEnd(range.startContainer, range.startOffset);
  const endRange = range.cloneRange();
  endRange.selectNodeContents(root);
  endRange.setEnd(range.endContainer, range.endOffset);
  return {
    start: startRange.toString().length,
    end: endRange.toString().length,
  };
};

const restoreSelectionOffsets = (root: HTMLElement, offsets: { start: number; end: number }) => {
  const selection = window.getSelection();
  if (!selection) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let node: Node | null;
  let current = 0;
  let startNode: Node | null = null;
  let endNode: Node | null = null;
  let startOffset = 0;
  let endOffset = 0;

  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (!startNode && current + length >= offsets.start) {
      startNode = node;
      startOffset = offsets.start - current;
    }
    if (!endNode && current + length >= offsets.end) {
      endNode = node;
      endOffset = offsets.end - current;
      break;
    }
    current += length;
  }

  const range = document.createRange();
  if (!startNode || !endNode) {
    range.selectNodeContents(root);
    range.collapse(false);
  } else {
    range.setStart(startNode, clamp(startOffset, 0, (startNode.textContent ?? "").length));
    range.setEnd(endNode, clamp(endOffset, 0, (endNode.textContent ?? "").length));
  }
  selection.removeAllRanges();
  selection.addRange(range);
};

const buildRangeFromOffsets = (root: HTMLElement, start: number, end: number) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let node: Node | null;
  let current = 0;
  let startNode: Node | null = null;
  let endNode: Node | null = null;
  let startOffset = 0;
  let endOffset = 0;

  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (!startNode && current + length >= start) {
      startNode = node;
      startOffset = start - current;
    }
    if (!endNode && current + length >= end) {
      endNode = node;
      endOffset = end - current;
      break;
    }
    current += length;
  }

  const range = document.createRange();
  if (!startNode || !endNode) {
    range.selectNodeContents(root);
    range.collapse(false);
    return range;
  }
  range.setStart(startNode, clamp(startOffset, 0, (startNode.textContent ?? "").length));
  range.setEnd(endNode, clamp(endOffset, 0, (endNode.textContent ?? "").length));
  return range;
};

export default function Composer(props: ComposerProps) {
  let editorRef: HTMLDivElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let inboxFileInputRef: HTMLInputElement | undefined;
  let variantPickerRef: HTMLDivElement | undefined;
  let mentionSearchRun = 0;
  let suppressPromptSync = false;
  let pasteCounter = 0;
  let draftScheduledAt = 0;
  let lastInputAt = 0;
  const pasteTextById = new Map<string, string>();
  const objectUrls = new Set<string>();
  const createObjectUrl = (file: File) => {
    const url = URL.createObjectURL(file);
    objectUrls.add(url);
    return url;
  };
  // Track IME composition state so we can combine it with keyCode === 229 to
  // reliably suppress Enter during CJK input across Chrome, Safari, and WebKit.
  let imeComposing = false;
  const [mentionIndex, setMentionIndex] = createSignal(0);
  const [mentionQuery, setMentionQuery] = createSignal("");
  const [mentionOpen, setMentionOpen] = createSignal(false);
  const [agentOptions, setAgentOptions] = createSignal<Agent[]>([]);
  const [agentLoaded, setAgentLoaded] = createSignal(false);
  const [searchResults, setSearchResults] = createSignal<string[]>([]);
  const [attachments, setAttachments] = createSignal<ComposerAttachment[]>([]);
  const [draftText, setDraftText] = createSignal(normalizeText(props.prompt));
  const [mode, setMode] = createSignal<PromptMode>("prompt");
  const [historySnapshot, setHistorySnapshot] = createSignal<ComposerDraft | null>(null);
  const [historyIndex, setHistoryIndex] = createSignal({ prompt: -1, shell: -1 });
  const [history, setHistory] = createSignal({ prompt: [] as ComposerDraft[], shell: [] as ComposerDraft[] });
  const [variantMenuOpen, setVariantMenuOpen] = createSignal(false);
  const [showInboxUploadAction, setShowInboxUploadAction] = createSignal(false);
  const activeVariant = createMemo(() => props.modelVariant ?? "none");
  const attachmentsDisabled = createMemo(() => !props.attachmentsEnabled);
  const hasDraftContent = createMemo(() => draftText().trim().length > 0 || attachments().length > 0);

  onCleanup(() => {
    for (const url of objectUrls) {
      URL.revokeObjectURL(url);
    }
    objectUrls.clear();
  });

  const createPasteSpan = (part: Extract<ComposerPart, { type: "paste" }>) => {
    pasteTextById.set(part.id, part.text);
    const span = document.createElement("span");
    span.textContent = part.label;
    span.contentEditable = "false";
    span.dataset.pasteId = part.id;
    span.dataset.pasteLabel = part.label;
    span.dataset.pasteLines = String(part.lines);
    span.title = "Click to expand pasted text";
    span.className =
      "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-dls-hover text-dls-secondary border border-dls-border cursor-pointer hover:bg-dls-active hover:text-dls-text";
    return span;
  };

  // Slash command state
  const [slashOpen, setSlashOpen] = createSignal(false);
  const [slashQuery, setSlashQuery] = createSignal("");
  const [slashIndex, setSlashIndex] = createSignal(0);
  const [slashCommands, setSlashCommands] = createSignal<SlashCommandOption[]>([]);
  const [slashLoaded, setSlashLoaded] = createSignal(false);

  onMount(() => {
    queueMicrotask(() => focusEditorEnd());

    // Bind composition events directly via addEventListener because SolidJS
    // does not delegate compositionstart/compositionend — the camelCase JSX
    // form (onCompositionStart) may silently fail to attach.
    if (editorRef) {
      editorRef.addEventListener("compositionstart", () => {
        imeComposing = true;
      });
      editorRef.addEventListener("compositionend", () => {
        requestAnimationFrame(() => {
          imeComposing = false;
        });
      });
    }
  });

  const mentionGroups = createMemo<MentionGroup[]>(() => {
    if (!mentionOpen()) return [];
    const query = mentionQuery().trim().toLowerCase();
    const agents: MentionOption[] = agentOptions().map((agent: Agent) => ({
      id: `agent:${agent.name}`,
      kind: "agent" as const,
      label: agent.name,
      value: agent.name,
      display: agent.name,
    }));
    const seen = new Set<string>();
    const recentFiles: MentionOption[] = props.recentFiles
      .filter((file: string) => {
        if (!file) return false;
        if (seen.has(file)) return false;
        seen.add(file);
        return true;
      })
      .map((file: string) => ({
        id: `file:${file}`,
        kind: "file" as const,
        label: file,
        value: file,
        display: file,
        recent: true,
      }));
    const searchFiles: MentionOption[] = searchResults()
      .filter((file: string) => file && !seen.has(file))
      .map((file: string) => ({
        id: `file:${file}`,
        kind: "file" as const,
        label: file,
        value: file,
        display: file,
      }));
    const all = [...agents, ...recentFiles, ...searchFiles];
    const list = query
      ? fuzzysort.go(query, all, { keys: ["display"] }).map((entry: any) => entry.obj)
      : all;
    const groups: MentionGroup[] = [];
    const bucket = new Map<MentionGroup["category"], MentionOption[]>();
    for (const item of list) {
      const category = item.kind === "agent" ? "agent" : item.recent ? "recent" : "file";
      const current = bucket.get(category);
      if (current) {
        current.push(item);
        continue;
      }
      bucket.set(category, [item]);
    }
    const order: MentionGroup["category"][] = ["agent", "file", "recent"];
    for (const category of order) {
      const items = bucket.get(category);
      if (!items?.length) continue;
      groups.push({ category, items });
    }
    return groups;
  });

  const mentionOptions = createMemo(() => mentionGroups().flatMap((group: MentionGroup) => group.items));
  const mentionVisible = createMemo(() => mentionOptions().slice(0, 10));

  createEffect(() => {
    if (!mentionOpen()) return;
    mentionOptions();
    setMentionIndex(0);
  });

  // Track recent emits to distinguish echoes from external updates.
  // Keep a bounded, time-windowed set so stale echoes cannot win races.
  const recentEmits = new Map<string, number>();
  const rememberRecentEmit = (value: string) => {
    const now = Date.now();
    if (recentEmits.has(value)) {
      recentEmits.delete(value);
    }
    recentEmits.set(value, now);

    for (const [key, timestamp] of recentEmits) {
      if (now - timestamp <= RECENT_EMIT_TTL_MS) break;
      recentEmits.delete(key);
    }

    while (recentEmits.size > MAX_RECENT_EMITS) {
      const oldest = recentEmits.keys().next();
      if (oldest.done) break;
      recentEmits.delete(oldest.value);
    }
  };

  const resetRecentEmits = (value: string) => {
    recentEmits.clear();
    rememberRecentEmit(value);
  };

  // Sync from props: ignore echoes of what we just sent
  createEffect(() => {
    if (!editorRef) return;
    const value = props.prompt;
    const current = normalizeText(editorRef.innerText);

    // Robust Echo Cancellation:
    // If the incoming value matches ANY recently emitted text, it's a stale echo or confirmation.
    // We ignore it to prevent overwriting the user's newer local state.
    if (recentEmits.has(value)) {
      // If we've converged (parent matches local), we can clean up the set to save memory,
      // but keeping a few items is cheap and safer for race conditions.
      if (value === current) {
        resetRecentEmits(value);
        setDraftText(value);
      }
      return;
    }

    // If we get here, 'value' is something we didn't send recently.
    // It must be an external event (History Navigation, Clear, Agent Action, etc).

    if (suppressPromptSync) {
      if (!value && current) {
        setEditorText("");
        setAttachments([]);
        setHistoryIndex((currentIndex: { prompt: number; shell: number }) => ({ ...currentIndex, [mode()]: -1 }));
        setHistorySnapshot(null);
        queueMicrotask(() => focusEditorEnd());
      }
      return;
    }
    if (value === current) {
      // Even if it matches current, make sure it's tracked as a valid base state
      rememberRecentEmit(value);
      setDraftText(value);
      return;
    }

    // External update confirmed
    if (value.startsWith("!") && mode() === "prompt") {
      setMode("shell");
      setEditorText(value.slice(1).trimStart());
      rememberRecentEmit(value);
      emitDraftChange();
      queueMicrotask(() => focusEditorEnd());
      return;
    }

    rememberRecentEmit(value); // It's now the new baseline
    setEditorText(value);
    if (!value) {
      setAttachments([]);
      setHistoryIndex((currentIndex: { prompt: number; shell: number }) => ({ ...currentIndex, [mode()]: -1 }));
      setHistorySnapshot(null);
    }

    // We don't emitDraftChange here usually, to avoid loops, but if we changed text we might need to?
    // Actually original code did emitDraftChange(). Let's keep it but be careful.
    // If we emit, we add to Set again.
    emitDraftChange();
    queueMicrotask(() => focusEditorEnd());
  });

  let emitTimer: number | null = null;
  const emitDraftChange = () => {
    if (!editorRef) return;
    draftScheduledAt = perfNow();

    if (emitTimer) window.clearTimeout(emitTimer);
    emitTimer = window.setTimeout(() => {
      flushDraftChange();
    }, DRAFT_FLUSH_DEBOUNCE_MS);
  };

  const flushDraftChange = () => {
    const flushStartedAt = perfNow();
    const queuedMs = draftScheduledAt > 0 ? Math.round((flushStartedAt - draftScheduledAt) * 100) / 100 : null;
    if (emitTimer) {
      window.clearTimeout(emitTimer);
      emitTimer = null;
    }
    if (!editorRef) return;
    const buildStartedAt = perfNow();
    const parts = buildPartsFromEditor(editorRef, pasteTextById);
    const buildMs = Math.round((perfNow() - buildStartedAt) * 100) / 100;
    const serializeStartedAt = perfNow();
    const text = normalizeText(partsToText(parts));
    const resolvedText = normalizeText(partsToResolvedText(parts));
    const serializeMs = Math.round((perfNow() - serializeStartedAt) * 100) / 100;
    setDraftText(text);

    rememberRecentEmit(text); // Track that we sent this, expect an echo later

    suppressPromptSync = true;
    const draftChangeStartedAt = perfNow();
    props.onDraftChange({
      mode: mode(),
      parts,
      attachments: attachments(),
      text,
      resolvedText,
    });
    const draftChangeMs = Math.round((perfNow() - draftChangeStartedAt) * 100) / 100;
    const totalMs = Math.round((perfNow() - flushStartedAt) * 100) / 100;
    if (
      props.developerMode &&
      ((queuedMs !== null && queuedMs >= 90) || buildMs >= 8 || serializeMs >= 8 || draftChangeMs >= 8 || totalMs >= 12 || text.length >= 2_500)
    ) {
      recordPerfLog(true, "session.input", "draft-flush", {
        queuedMs,
        buildMs,
        serializeMs,
        draftChangeMs,
        totalMs,
        chars: text.length,
        parts: parts.length,
        mode: mode(),
      });
    }
    draftScheduledAt = 0;
    queueMicrotask(() => {
      suppressPromptSync = false;
    });
  };

  const handleEditorInput = () => {
    const startedAt = perfNow();
    const currentText = normalizeText(editorRef?.innerText ?? "");
    const mentionStartedAt = perfNow();
    if (mentionOpen() || currentText.includes("@")) {
      updateMentionQuery(currentText);
    } else {
      setMentionOpen(false);
      setMentionQuery("");
    }
    const mentionMs = Math.round((perfNow() - mentionStartedAt) * 100) / 100;
    const slashStartedAt = perfNow();
    updateSlashQuery(currentText);
    const slashMs = Math.round((perfNow() - slashStartedAt) * 100) / 100;
    setDraftText(currentText);
    emitDraftChange();

    const totalMs = Math.round((perfNow() - startedAt) * 100) / 100;
    const now = Date.now();
    const sincePrevInputMs = lastInputAt > 0 ? now - lastInputAt : null;
    lastInputAt = now;

    if (props.developerMode && (totalMs >= 8 || mentionMs >= 4 || slashMs >= 4)) {
      recordPerfLog(true, "session.input", "keystroke", {
        totalMs,
        mentionMs,
        slashMs,
        sincePrevInputMs,
        chars: editorRef?.innerText.length ?? 0,
        mentionOpen: mentionOpen(),
        slashOpen: slashOpen(),
      });
    }
  };

  const focusEditorEnd = () => {
    if (!editorRef) return;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(editorRef);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    editorRef.focus();
  };

  const renderParts = (parts: ComposerPart[], keepSelection = true) => {
    if (!editorRef) return;
    const selection = keepSelection ? getSelectionOffsets(editorRef) : null;
    editorRef.innerHTML = "";
    parts.forEach((part) => {
      if (part.type === "text") {
        insertTextWithBreaks(editorRef!, part.text);
        return;
      }
      if (part.type === "paste") {
        const span = createPasteSpan(part);
        editorRef?.appendChild(span);
        editorRef?.appendChild(document.createTextNode(" "));
        return;
      }
      const span = createMentionSpan(part);
      editorRef?.appendChild(span);
      editorRef?.appendChild(document.createTextNode(" "));
    });
    if (selection) {
      restoreSelectionOffsets(editorRef, selection);
    }
  };

  const setEditorText = (value: string) => {
    if (!editorRef) return;
    setDraftText(normalizeText(value));
    renderParts(value ? [{ type: "text", text: value }] : [], false);
  };

  const updateMentionQuery = (currentText?: string) => {
    if (!editorRef) return;
    if (mode() === "shell") {
      setMentionOpen(false);
      setMentionQuery("");
      return;
    }
    const offsets = getSelectionOffsets(editorRef);
    if (!offsets || offsets.start !== offsets.end) {
      setMentionOpen(false);
      setMentionQuery("");
      return;
    }
    const text = currentText ?? normalizeText(editorRef.innerText);
    const before = text.slice(0, offsets.start);
    const match = before.match(/@(\S*)$/);
    if (!match) {
      setMentionOpen(false);
      setMentionQuery("");
      return;
    }
    setMentionQuery(match[1] ?? "");
    setMentionOpen(true);
  };

  const updateSlashQuery = (currentText?: string) => {
    if (!editorRef) return;
    if (mode() === "shell") {
      setSlashOpen(false);
      setSlashQuery("");
      return;
    }
    const text = currentText ?? normalizeText(editorRef.innerText);
    // Only trigger when the entire input matches /command (no spaces, starts with /)
    const slashMatch = text.match(/^\/(\S*)$/);
    if (!slashMatch) {
      setSlashOpen(false);
      setSlashQuery("");
      return;
    }
    setSlashQuery(slashMatch[1] ?? "");
    setSlashOpen(true);
  };

  const slashFiltered = createMemo(() => {
    if (!slashOpen()) return [];
    const query = slashQuery().trim().toLowerCase();
    const commands = slashCommands();
    if (!query) return commands.slice(0, 15);
    return fuzzysort
      .go(query, commands, { keys: ["name", "description"] })
      .map((entry: any) => entry.obj)
      .slice(0, 15);
  });

  createEffect(() => {
    if (!slashOpen()) return;
    slashFiltered();
    setSlashIndex(0);
  });

  // Fetch commands when slash popup opens for the first time
  createEffect(() => {
    if (!slashOpen() || slashLoaded()) return;
    props
      .listCommands()
      .then((commands) => setSlashCommands(commands))
      .catch(() => setSlashCommands([]))
      .finally(() => setSlashLoaded(true));
  });

  // If the editor contains an exact /command (no spaces), auto-convert it into a styled chip.
  // This enables flows like pre-filling "/skill-creator" from other pages.
  createEffect(() => {
    if (!slashOpen()) return;
    const query = slashQuery().trim();
    if (!query) return;
    const cmd = slashCommands().find((c) => c.name === query);
    if (!cmd) return;
    handleSlashSelect(cmd);
  });

  const handleSlashSelect = (cmd: SlashCommandOption) => {
    if (!editorRef) return;
    setSlashOpen(false);
    setSlashQuery("");
    // Replace editor content with a styled "/<command>" chip and a trailing space for args.
    const text = `/${cmd.name} `;
    editorRef.innerHTML = "";
    const chip = createSlashSpan(cmd);
    editorRef.appendChild(chip);
    editorRef.appendChild(document.createTextNode(" "));
    suppressPromptSync = true;
    props.onDraftChange({
      mode: mode(),
      parts: [{ type: "text", text }],
      attachments: attachments(),
      text,
    });
    queueMicrotask(() => {
      suppressPromptSync = false;
    });
    requestAnimationFrame(() => {
      editorRef!.focus();
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(editorRef!);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    });
  };

  const insertMention = (option: MentionOption) => {
    if (!editorRef) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const beforeRange = range.cloneRange();
    beforeRange.selectNodeContents(editorRef);
    beforeRange.setEnd(range.endContainer, range.endOffset);
    const beforeText = normalizeText(beforeRange.toString());
    const match = beforeText.match(/@(\S*)$/);
    if (!match) return;
    const start = match.index ?? beforeText.length - match[0].length;
    const end = beforeText.length;
    const deleteRange = buildRangeFromOffsets(editorRef, start, end);
    deleteRange.deleteContents();

    const mentionPart =
      option.kind === "agent"
        ? ({ type: "agent", name: option.value } as ComposerPart)
        : ({ type: "file", path: option.value, label: option.label } as ComposerPart);
    const mentionNode = createMentionSpan(mentionPart as Extract<ComposerPart, { type: "agent" | "file" }>);
    deleteRange.insertNode(mentionNode);
    mentionNode.after(document.createTextNode(" "));

    const cursor = document.createRange();
    cursor.setStartAfter(mentionNode.nextSibling ?? mentionNode);
    cursor.collapse(true);
    selection.removeAllRanges();
    selection.addRange(cursor);
    setMentionOpen(false);
    setMentionQuery("");
    emitDraftChange();
  };

  const canNavigateHistory = () => {
    if (!editorRef) return false;
    const offsets = getSelectionOffsets(editorRef);
    if (!offsets || offsets.start !== offsets.end) return false;
    const total = normalizeText(editorRef.innerText).length;
    return offsets.start === 0 || offsets.start === total;
  };

  const applyHistoryDraft = (draft: ComposerDraft | null) => {
    if (!draft) return;
    setMode(draft.mode);
    renderParts(draft.parts, false);
    setDraftText(draft.text);
    setAttachments(draft.attachments ?? []);
    props.onDraftChange(draft);
  };

  const navigateHistory = (direction: "up" | "down") => {
    const key = mode();
    const list = history()[key];
    if (!list.length) return;
    const index = historyIndex()[key];
    const nextIndex = direction === "up" ? index + 1 : index - 1;
    if (nextIndex < -1 || nextIndex >= list.length) return;

    if (index === -1 && direction === "up") {
      const parts = editorRef ? buildPartsFromEditor(editorRef, pasteTextById) : [];
      const text = normalizeText(partsToText(parts));
      const resolvedText = normalizeText(partsToResolvedText(parts));
      setHistorySnapshot({ mode: key, parts, attachments: attachments(), text, resolvedText });
    }

    setHistoryIndex((current: { prompt: number; shell: number }) => ({ ...current, [key]: nextIndex }));
    if (nextIndex === -1) {
      applyHistoryDraft(historySnapshot());
      setHistorySnapshot(null);
      return;
    }
    const target = list[list.length - 1 - nextIndex];
    applyHistoryDraft(target);
  };

  const sendDraft = () => {
    // Ensure any pending debounce updates are committed before sending
    flushDraftChange();

    if (!editorRef) return;
    const parts = buildPartsFromEditor(editorRef, pasteTextById);
    const text = normalizeText(partsToText(parts));
    const resolvedText = normalizeText(partsToResolvedText(parts));
    const draft: ComposerDraft = { mode: mode(), parts, attachments: attachments(), text, resolvedText };

    // Detect slash command: text like "/commandname arg1 arg2"
    if (text.startsWith("/")) {
      const [cmdToken, ...argTokens] = text.split(" ");
      const commandName = cmdToken.slice(1); // strip leading /
      if (commandName) {
        const matchedCommand = slashCommands().find((c) => c.name === commandName);
        if (matchedCommand) {
          draft.command = { name: commandName, arguments: argTokens.join(" ") };
        }
      }
    }

    recordHistory(draft);
    props.onSend(draft);
    setSlashOpen(false);
    setSlashQuery("");
    setAttachments([]);
    setEditorText("");
    emitDraftChange();
    queueMicrotask(() => focusEditorEnd());
  };

  const recordHistory = (draft: ComposerDraft) => {
    const trimmed = draft.text.trim();
    if (!trimmed && !draft.attachments.length) return;
    setHistory((current: { prompt: ComposerDraft[]; shell: ComposerDraft[] }) => ({
      ...current,
      [draft.mode]: [...current[draft.mode], { ...draft, attachments: [] }],
    }));
    setHistoryIndex((current: { prompt: number; shell: number }) => ({ ...current, [draft.mode]: -1 }));
    setHistorySnapshot(null);
  };

  const addAttachments = async (files: File[]) => {
    if (attachmentsDisabled()) {
      props.onToast(props.attachmentsDisabledReason ?? "Attachments are unavailable.");
      return;
    }
    const next: ComposerAttachment[] = [];
    for (const file of files) {
      if (!isSupportedAttachmentType(file.type)) {
        props.onToast(`${file.name} is not a supported attachment type.`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        props.onToast(`${file.name} exceeds the 8MB limit.`);
        continue;
      }
      try {
        // Compress images before encoding to data URL
        const processed = isImageMime(file.type) ? await compressImageFile(file) : file;
        const dataUrl = await fileToDataUrl(processed);
        // Pre-check: data URL will be embedded in JSON body; reject if too large
        const estimatedJsonBytes = dataUrl.length + 512; // data URL + JSON overhead
        if (estimatedJsonBytes > MAX_ATTACHMENT_BYTES) {
          props.onToast(`${file.name} is too large after encoding. Try a smaller image.`);
          continue;
        }
        next.push({
          id: `${processed.name}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
          name: processed.name,
          mimeType: processed.type || "application/octet-stream",
          size: processed.size,
          kind: isImageMime(processed.type) ? "image" : "file",
          dataUrl,
        });
      } catch (error) {
        props.onToast(error instanceof Error ? error.message : "Failed to read attachment");
      }
    }
    if (next.length) {
      setAttachments((current: ComposerAttachment[]) => [...current, ...next]);
      emitDraftChange();
    }
  };

  const insertPlainTextAtSelection = (text: string) => {
    if (!editorRef) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const fragment = textToFragment(text);
    const last = fragment.lastChild;
    range.insertNode(fragment);

    if (!last) return;
    const cursor = document.createRange();
    cursor.setStartAfter(last);
    cursor.collapse(true);
    selection.removeAllRanges();
    selection.addRange(cursor);
  };

  const insertCollapsedPasteAtSelection = (text: string, lines: number) => {
    if (!editorRef) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();

    pasteCounter += 1;
    const id = `paste-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const label = `[pasted text ${pasteCounter}]`;
    const part = { type: "paste", id, label, text, lines } as const;
    const span = createPasteSpan(part);

    range.insertNode(span);
    span.after(document.createTextNode(" "));

    const cursor = document.createRange();
    cursor.setStartAfter(span.nextSibling ?? span);
    cursor.collapse(true);
    selection.removeAllRanges();
    selection.addRange(cursor);
  };

  const handleEditorClick = (event: MouseEvent) => {
    if (!editorRef) return;
    const target = event.target as HTMLElement | null;
    const span = (target?.closest?.("span[data-paste-id]") as HTMLElement | null) ?? null;
    if (!span || !editorRef.contains(span)) return;
    const id = span.dataset.pasteId ?? "";
    if (!id) return;
    const text = pasteTextById.get(id);
    if (typeof text !== "string") return;

    event.preventDefault();
    event.stopPropagation();

    const fragment = textToFragment(text);
    const last = fragment.lastChild;
    span.replaceWith(fragment);
    pasteTextById.delete(id);

    const selection = window.getSelection();
    if (selection) {
      const cursor = document.createRange();
      if (last && last.parentNode) {
        cursor.setStartAfter(last);
        cursor.collapse(true);
      } else {
        cursor.selectNodeContents(editorRef);
        cursor.collapse(false);
      }
      selection.removeAllRanges();
      selection.addRange(cursor);
    }

    updateMentionQuery();
    updateSlashQuery();
    emitDraftChange();
  };

  const insertUnsupportedFileLinks = async (files: File[], clipboardLinks: string[]) => {
    const fallbackLinks = () =>
      files.map((file, index) => ({
        name: file.name || `file-${index + 1}`,
        target: clipboardLinks[index] || createObjectUrl(file),
      }));

    if (props.isSandboxWorkspace && props.onUploadInboxFiles) {
      const uploaded = await Promise.resolve(props.onUploadInboxFiles(files, { notify: false }));
      if (Array.isArray(uploaded) && uploaded.length) {
        const links = uploaded
          .map((item, index) => {
            const target = inboxPathToLink(item.path ?? "");
            const fallbackName = files[index]?.name || `file-${index + 1}`;
            const name = item.name?.trim() || fallbackName;
            return { name, target };
          })
          .filter((entry) => entry.target);
        const text = formatLinks(links);
        if (text) {
          insertPlainTextAtSelection(text);
          updateMentionQuery();
          updateSlashQuery();
          emitDraftChange();
          props.onToast(
            links.length === 1
              ? `Uploaded ${links[0].name} to inbox and inserted a link.`
              : `Uploaded ${links.length} files to inbox and inserted links.`,
          );
          return;
        }
      }
      props.onToast("Couldn't upload to inbox. Inserted local links instead.");
    }

    const text = formatLinks(fallbackLinks());
    if (!text) {
      props.onToast("Unsupported attachment type.");
      return;
    }
    insertPlainTextAtSelection(text);
    updateMentionQuery();
    updateSlashQuery();
    emitDraftChange();
    props.onToast("Inserted links for unsupported files.");
  };

  const handlePaste = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    const clipboard = event.clipboardData;
    const fileItems = Array.from(clipboard.items || []).filter((item) => item.kind === "file");
    const files = Array.from(clipboard.files || []);
    const itemFiles = fileItems
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    const allFiles = files.length ? files : itemFiles;
    if (allFiles.length) {
      event.preventDefault();
      const supported = allFiles.filter((file) => isSupportedAttachmentType(file.type));
      const unsupported = allFiles.filter((file) => !isSupportedAttachmentType(file.type));
      if (supported.length) {
        void addAttachments(supported);
      }
      if (unsupported.length) {
        const links = parseClipboardLinks(clipboard);
        void insertUnsupportedFileLinks(unsupported, links);
      }
      return;
    }

    const plainForCheck = clipboard.getData("text/plain") ?? "";
    const trimmedForCheck = plainForCheck.trim();
    if (trimmedForCheck && (props.isSandboxWorkspace || props.isRemoteWorkspace)) {
      const hasFileUrl = /file:\/\//i.test(trimmedForCheck);
      const hasAbsolutePosix = /(^|\s)\/(Users|home|var|etc|opt|tmp|private|Volumes|Applications)\//.test(trimmedForCheck);
      const hasAbsoluteWindows = /(^|\s)[a-zA-Z]:\\/.test(trimmedForCheck);
      if (hasFileUrl || hasAbsolutePosix || hasAbsoluteWindows) {
        props.onToast(
          "This is a remote worker. Sandboxes are remote too. To share files with it, upload them to the Inbox in the sidebar.",
        );
        setShowInboxUploadAction(Boolean(props.onUploadInboxFiles));
      }
    }

    const plain = clipboard.getData("text/plain") || clipboard.getData("text") || "";
    const html = clipboard.getData("text/html") || "";
    const raw = plain || (html ? htmlToPlainText(html) : "");
    if (!raw) return;

    event.preventDefault();
    const text = sanitizePastedPlainText(raw);
    const lines = countLines(text);
    if (lines > 10) {
      insertCollapsedPasteAtSelection(text, lines);
    } else {
      insertPlainTextAtSelection(text);
    }

    updateMentionQuery();
    updateSlashQuery();
    emitDraftChange();
  };

  createEffect(() => {
    if (!props.toast) {
      setShowInboxUploadAction(false);
    }
  });

  const handleDrop = (event: DragEvent) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length) void addAttachments(files);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    // Make slash chips behave like single tokens.
    if ((event.key === "Backspace" || event.key === "Delete") && editorRef) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount) {
        const range = selection.getRangeAt(0);
        if (range.collapsed) {
          const container = range.startContainer;
          const offset = range.startOffset;

          const resolvePreviousSibling = () => {
            if (container === editorRef) {
              return offset > 0 ? editorRef.childNodes[offset - 1] : null;
            }
            if (container.nodeType === Node.TEXT_NODE) {
              const parent = container.parentNode;
              if (parent === editorRef) {
                if (offset > 0) return null;
                return container.previousSibling;
              }
            }
            return null;
          };

          const prev = resolvePreviousSibling();
          if (prev instanceof HTMLElement && prev.dataset.slashCommand) {
            event.preventDefault();
            // Also remove a single trailing space node if present.
            const next = prev.nextSibling;
            if (next && next.nodeType === Node.TEXT_NODE && (next.textContent ?? "") === " ") {
              next.parentNode?.removeChild(next);
            }
            prev.parentNode?.removeChild(prev);
            emitDraftChange();
            return;
          }
        }
      }
    }

    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      document.execCommand("insertLineBreak");
      emitDraftChange();
      return;
    }
    // Block Enter while IME is composing. We check three signals:
    // 1. event.isComposing — standard API (unreliable in some WebKit builds)
    // 2. imeComposing — manual flag from compositionstart/end
    // 3. event.keyCode === 229 — legacy but reliable IME indicator across all browsers
    const imeActive = event.isComposing || imeComposing || event.keyCode === 229;
    if (event.key === "Enter" && imeActive) return;

    if (mentionOpen()) {
      const options = mentionOptions();
      const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      if (event.key === "Enter" && !imeActive) {
        event.preventDefault();
        const active = options[mentionIndex()] ?? options[0];
        if (active) insertMention(active);
        return;
      }
      if (event.key === "ArrowDown" || (ctrl && event.key === "n")) {
        event.preventDefault();
        if (!options.length) return;
        setMentionIndex((i: number) => (i + 1) % options.length);
        return;
      }
      if (event.key === "ArrowUp" || (ctrl && event.key === "p")) {
        event.preventDefault();
        if (!options.length) return;
        setMentionIndex((i: number) => (i - 1 + options.length) % options.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionOpen(false);
        setMentionQuery("");
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const active = options[mentionIndex()] ?? options[0];
        if (active) insertMention(active);
        return;
      }
    }

    // Slash command popup keyboard navigation
    if (slashOpen()) {
      const options = slashFiltered();
      const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      if (event.key === "Enter" && !imeActive) {
        event.preventDefault();
        const active = options[slashIndex()] ?? options[0];
        if (active) handleSlashSelect(active);
        return;
      }
      if (event.key === "ArrowDown" || (ctrl && event.key === "n")) {
        event.preventDefault();
        if (!options.length) return;
        setSlashIndex((i: number) => (i + 1) % options.length);
        return;
      }
      if (event.key === "ArrowUp" || (ctrl && event.key === "p")) {
        event.preventDefault();
        if (!options.length) return;
        setSlashIndex((i: number) => (i - 1 + options.length) % options.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashOpen(false);
        setSlashQuery("");
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const active = options[slashIndex()] ?? options[0];
        if (active) handleSlashSelect(active);
        return;
      }
    }

    if (event.key === "!" && mode() === "prompt") {
      const offsets = editorRef ? getSelectionOffsets(editorRef) : null;
      if (offsets && offsets.start === 0 && offsets.end === 0) {
        event.preventDefault();
        setMode("shell");
        emitDraftChange();
        return;
      }
    }

    if (event.key === "Escape" && mode() === "shell") {
      event.preventDefault();
      setMode("prompt");
      emitDraftChange();
      return;
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (canNavigateHistory()) {
        event.preventDefault();
        navigateHistory(event.key === "ArrowUp" ? "up" : "down");
        return;
      }
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (props.busy) return;
      sendDraft();
    }
  };

  createEffect(() => {
    if (!mentionOpen() || agentLoaded()) return;
    props
      .listAgents()
      .then((agents) => setAgentOptions(agents))
      .catch(() => setAgentOptions([]))
      .finally(() => setAgentLoaded(true));
  });

  createEffect(() => {
    if (!mentionOpen()) {
      setSearchResults([]);
      return;
    }
    const query = mentionQuery().trim();
    if (!query) {
      setSearchResults([]);
      return;
    }
    const runId = (mentionSearchRun += 1);
    const timeout = window.setTimeout(() => {
      props
        .searchFiles(query)
        .then((results) => {
          if (runId !== mentionSearchRun) return;
          setSearchResults(results);
        })
        .catch(() => {
          if (runId !== mentionSearchRun) return;
          setSearchResults([]);
        });
    }, 150);
    onCleanup(() => {
      window.clearTimeout(timeout);
    });
  });

  createEffect(() => {
    if (mode() !== "shell") return;
    setMentionOpen(false);
    setMentionQuery("");
    setSlashOpen(false);
    setSlashQuery("");
  });



  createEffect(() => {
    if (!variantMenuOpen()) return;
    const handler = (event: MouseEvent) => {
      if (!variantPickerRef) return;
      if (variantPickerRef.contains(event.target as Node)) return;
      setVariantMenuOpen(false);
    };
    window.addEventListener("mousedown", handler);
    onCleanup(() => window.removeEventListener("mousedown", handler));
  });

  createEffect(() => {
    const handler = () => {
      editorRef?.focus();
    };
    window.addEventListener("openwork:focusPrompt", handler);
    onCleanup(() => window.removeEventListener("openwork:focusPrompt", handler));
  });

  onCleanup(() => {
    if (emitTimer !== null) {
      window.clearTimeout(emitTimer);
      emitTimer = null;
    }
  });

  return (
    <div class="px-4 pb-4 pt-0 bg-dls-surface sticky bottom-0 z-20" style={{ contain: "layout style" }}>
      <div class="max-w-3xl mx-auto">
        <div
          class={`bg-dls-surface border border-dls-border rounded-2xl overflow-visible transition-all relative group/input ${mentionOpen() || slashOpen() ? "rounded-t-none border-t-transparent shadow-none" : "shadow-xl"
            }`}
          onDrop={handleDrop}
          onDragOver={(event: DragEvent) => {
            if (attachmentsDisabled()) return;
            event.preventDefault();
          }}
        >
          <Show when={mentionOpen()}>
            <div class="absolute bottom-full left-[-1px] right-[-1px] z-30">
              <div class="rounded-t-3xl border border-dls-border border-b-0 bg-dls-surface shadow-xl overflow-hidden">
                <div class="p-2 bg-dls-surface max-h-64 overflow-y-auto" onMouseDown={(event: MouseEvent) => event.preventDefault()}>
                  <Show
                    when={mentionVisible().length}
                    fallback={<div class="px-3 py-2 text-xs text-dls-secondary">No matches found.</div>}
                  >
                    <For each={mentionVisible()}>
                      {(option: MentionOption) => {
                        const optionIndex = createMemo(() => mentionOptions().findIndex((item) => item.id === option.id));
                        const active = createMemo(() => mentionOptions()[mentionIndex()]?.id === option.id);
                        return (
                          <button
                            type="button"
                            class={`w-full flex items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors ${active() ? "bg-dls-active text-dls-text" : "text-dls-text hover:bg-dls-hover"
                              }`}
                            onMouseDown={(event: MouseEvent) => {
                              event.preventDefault();
                              insertMention(option);
                            }}
                            onMouseEnter={() => setMentionIndex(optionIndex())}
                          >
                            <Show
                              when={option.kind === "agent"}
                              fallback={
                                <>
                                  <FileIcon size={14} class="text-dls-secondary" />
                                  <div class="flex items-center min-w-0 text-xs">
                                    {(() => {
                                      const value = option.value;
                                      const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
                                      const dir = slash === -1 ? "" : value.slice(0, slash + 1);
                                      const name = slash === -1 ? value : value.slice(slash + 1);
                                      return (
                                        <>
                                          <span class="text-dls-secondary truncate">{dir}</span>
                                          <Show when={name}>
                                            <span class="text-dls-text font-semibold">{name}</span>
                                          </Show>
                                        </>
                                      );
                                    })()}
                                  </div>
                                </>
                              }
                            >
                              <AtSign size={14} class="text-dls-secondary" />
                              <span class="text-xs font-semibold text-dls-text">@{option.label}</span>
                            </Show>
                          </button>
                        );
                      }}
                    </For>
                  </Show>
                </div>
              </div>
            </div>
          </Show>

          {/* Slash command popup */}
          <Show when={slashOpen()}>
            <div class="absolute bottom-full left-[-1px] right-[-1px] z-30">
              <div class="rounded-t-3xl border border-dls-border border-b-0 bg-dls-surface overflow-hidden">
                <div class="p-2 bg-dls-surface max-h-64 overflow-y-auto" onMouseDown={(event: MouseEvent) => event.preventDefault()}>
                  <Show
                    when={slashFiltered().length}
                    fallback={
                      <div class="px-3 py-2 text-xs text-dls-secondary">
                        {slashLoaded() ? "No commands found." : "Loading commands..."}
                      </div>
                    }
                  >
                    <For each={slashFiltered()}>
                      {(cmd: SlashCommandOption, index) => {
                        const active = createMemo(() => slashIndex() === index());
                        return (
                          <button
                            type="button"
                            class={`w-full flex items-center justify-between gap-4 rounded-xl px-3 py-2 text-left transition-colors ${active() ? "bg-dls-active text-dls-text" : "text-dls-text hover:bg-dls-hover"
                              }`}
                            onMouseDown={(event: MouseEvent) => {
                              event.preventDefault();
                              handleSlashSelect(cmd);
                            }}
                            onMouseEnter={() => setSlashIndex(index())}
                          >
                            <div class="flex items-center gap-2 min-w-0">
                              <Terminal size={14} class="text-dls-secondary shrink-0" />
                              <span class="text-xs font-semibold text-dls-text whitespace-nowrap">/{cmd.name}</span>
                              <Show when={cmd.description}>
                                <span class="text-xs text-dls-secondary truncate">{cmd.description}</span>
                              </Show>
                            </div>
                            <Show when={cmd.source && cmd.source !== "command"}>
                              <span class="text-[10px] uppercase tracking-wider text-dls-secondary shrink-0">
                                {cmd.source === "skill" ? "Skill" : cmd.source === "mcp" ? "MCP" : ""}
                              </span>
                            </Show>
                          </button>
                        );
                      }}
                    </For>
                  </Show>
                </div>
              </div>
            </div>
          </Show>

          <div class="p-3 px-4">
            <Show when={props.showNotionBanner}>
              <button
                type="button"
                class="w-full mb-2 flex items-center justify-between gap-3 rounded-xl border border-green-7/20 bg-green-7/10 px-3 py-2 text-left text-sm text-green-12 transition-colors hover:bg-green-7/15"
                onClick={props.onNotionBannerClick}
              >
                <span>Try it now: set up my CRM in Notion</span>
                <span class="text-xs text-green-12 font-medium">Insert prompt</span>
              </button>
            </Show>

            <Show when={attachments().length}>
              <div class="mb-3 flex flex-wrap gap-2">
                <For each={attachments()}>
                  {(attachment: ComposerAttachment) => (
                    <div class="flex items-center gap-2 rounded-2xl border border-dls-border bg-dls-hover px-3 py-2 text-xs text-dls-secondary">
                      <Show
                        when={attachment.kind === "image"}
                        fallback={<FileIcon size={14} class="text-dls-secondary" />}
                      >
                        <div class="h-10 w-10 rounded-xl bg-dls-surface overflow-hidden border border-dls-border">
                          <img src={attachment.dataUrl} alt={attachment.name} class="h-full w-full object-cover" />
                        </div>
                      </Show>
                      <div class="max-w-[160px]">
                        <div class="truncate text-dls-text">{attachment.name}</div>
                        <div class="text-[10px] text-dls-secondary">
                          {attachment.kind === "image" ? "Image" : attachment.mimeType || "File"}
                        </div>
                      </div>
                      <button
                        type="button"
                        class="ml-1 rounded-full p-1 text-dls-secondary hover:text-dls-text hover:bg-dls-active"
                        onClick={() => {
                          setAttachments((current: ComposerAttachment[]) =>
                            current.filter((item) => item.id !== attachment.id)
                          );
                          emitDraftChange();
                        }}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <div class="relative min-h-[120px]">
              <Show when={props.toast}>
                <div class="absolute bottom-full right-0 mb-2 z-30 rounded-xl border border-dls-border bg-dls-surface px-3 py-2 text-xs text-dls-secondary shadow-lg backdrop-blur-md">
                  <div class="flex items-center gap-3">
                    <span>{props.toast}</span>
                    <Show when={showInboxUploadAction() && props.onUploadInboxFiles}>
                      <button
                        type="button"
                        class="shrink-0 rounded-md border border-dls-border bg-dls-hover px-2 py-1 text-[10px] text-dls-text hover:bg-dls-active"
                        onClick={() => inboxFileInputRef?.click()}
                      >
                        Upload to inbox
                      </button>
                    </Show>
                  </div>
                </div>
              </Show>

              <div class="flex flex-col gap-2">
                <div class="flex-1 min-w-0">
                  <Show when={props.isRemoteWorkspace}>
                    <div class="mb-2 text-[10px] uppercase tracking-wider text-dls-secondary">Remote workspace</div>
                  </Show>

                  <div class="relative">
                    <Show when={!hasDraftContent()}>
                      <div class="absolute left-0 top-0 text-dls-secondary text-sm leading-relaxed pointer-events-none">
                        Ask OpenWork...
                      </div>
                    </Show>
                    <div
                      ref={editorRef}
                      contentEditable={true}
                      role="textbox"
                      aria-multiline="true"
                      onInput={handleEditorInput}
                      onKeyDown={handleKeyDown}
                      onPaste={handlePaste}
                      onClick={handleEditorClick}
                      class="bg-transparent border-none p-0 pb-8 pr-4 text-dls-text focus:ring-0 text-sm leading-relaxed resize-none min-h-[24px] max-h-40 overflow-y-auto outline-none relative z-10"
                    />

                    <div class="mt-3 flex items-center justify-between px-2 pb-2">
                      <div class="flex items-center gap-2">
                        <input
                          ref={inboxFileInputRef}
                          type="file"
                          multiple
                          class="hidden"
                          onChange={(event: Event) => {
                            const target = event.currentTarget as HTMLInputElement;
                            const files = Array.from(target.files ?? []);
                            if (files.length && props.onUploadInboxFiles) {
                              void Promise.resolve(props.onUploadInboxFiles(files));
                            }
                            target.value = "";
                          }}
                        />
                        <input
                          ref={fileInputRef}
                          type="file"
                          multiple
                          accept={ACCEPTED_FILE_TYPES.join(",")}
                          class="hidden"
                          disabled={attachmentsDisabled()}
                          onChange={(event: Event) => {
                            const target = event.currentTarget as HTMLInputElement;
                            const files = Array.from(target.files ?? []);
                            if (files.length) void addAttachments(files);
                            target.value = "";
                          }}
                        />
                        <button
                          type="button"
                          class={`p-1.5 hover:bg-dls-hover rounded-md text-dls-secondary transition-colors ${attachmentsDisabled() ? "cursor-not-allowed" : ""
                            }`}
                          onClick={() => {
                            if (attachmentsDisabled()) return;
                            fileInputRef?.click();
                          }}
                          disabled={attachmentsDisabled()}
                          title={
                            attachmentsDisabled()
                              ? props.attachmentsDisabledReason ?? "Attachments are unavailable."
                              : "Attach files"
                          }
                        >
                          <Paperclip size={16} />
                        </button>

                        <div class="relative" ref={(el) => props.setAgentPickerRef(el)}>
                          <button
                            type="button"
                            class="flex items-center gap-1.5 px-2 py-1 hover:bg-dls-hover rounded-md text-xs font-medium text-dls-secondary hover:text-dls-text"
                            onClick={props.onToggleAgentPicker}
                            disabled={props.busy}
                            aria-expanded={props.agentPickerOpen}
                            title="Agent"
                          >
                            <AtSign size={14} />
                            <span class="max-w-[140px] truncate">{props.agentLabel}</span>
                            <ChevronDown size={14} />
                          </button>

                          <Show when={props.agentPickerOpen}>
                            <div class="absolute left-0 bottom-full mb-2 w-64 rounded-xl border border-dls-border bg-dls-surface shadow-xl backdrop-blur-md overflow-hidden z-40">
                              <div class="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-dls-secondary border-b border-dls-border">
                                Agent
                              </div>

                              <div class="p-2 space-y-1 max-h-64 overflow-y-auto" onMouseDown={(event: MouseEvent) => event.preventDefault()}>
                                <Show
                                  when={!props.agentPickerBusy}
                                  fallback={
                                    <div class="px-3 py-2 text-xs text-dls-secondary">Loading agents...</div>
                                  }
                                >
                                  <Show when={!props.agentPickerError}>
                                    <button
                                      type="button"
                                      class={`w-full flex items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${!props.selectedAgent
                                        ? "bg-dls-active text-dls-text"
                                        : "text-dls-secondary hover:bg-dls-hover"
                                        }`}
                                      onMouseDown={(event: MouseEvent) => {
                                        event.preventDefault();
                                        props.onSelectAgent(null);
                                      }}
                                    >
                                      <span>Default agent</span>
                                      <Show when={!props.selectedAgent}>
                                        <Check size={14} class="text-dls-secondary" />
                                      </Show>
                                    </button>

                                    <For each={props.agentOptions}>
                                      {(agent: Agent) => {
                                        const active = () => props.selectedAgent === agent.name;
                                        return (
                                          <button
                                            type="button"
                                            class={`w-full flex items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${active()
                                              ? "bg-dls-active text-dls-text"
                                              : "text-dls-secondary hover:bg-dls-hover"
                                              }`}
                                            onMouseDown={(event: MouseEvent) => {
                                              event.preventDefault();
                                              props.onSelectAgent(agent.name);
                                            }}
                                          >
                                            <span class="truncate">@{agent.name}</span>
                                            <Show when={active()}>
                                              <Check size={14} class="text-dls-secondary" />
                                            </Show>
                                          </button>
                                        );
                                      }}
                                    </For>
                                  </Show>

                                  <Show when={props.agentPickerError}>
                                    <div class="px-3 py-2 text-xs text-red-11">
                                      {props.agentPickerError}
                                    </div>
                                  </Show>
                                </Show>
                              </div>
                            </div>
                          </Show>
                        </div>

                        <button
                          type="button"
                          class="flex items-center gap-1.5 px-2 py-1 hover:bg-dls-hover rounded-md text-xs font-medium text-dls-secondary hover:text-dls-text"
                          onClick={props.onModelClick}
                          disabled={props.busy}
                        >
                          {props.selectedModelLabel}
                          <ChevronDown size={14} />
                        </button>
                        <div class="relative" ref={(el) => (variantPickerRef = el)}>
                          <button
                            type="button"
                            class="flex items-center gap-1.5 px-2 py-1 hover:bg-dls-hover rounded-md text-xs font-medium text-dls-secondary hover:text-dls-text"
                            onClick={() => setVariantMenuOpen((open) => !open)}
                            disabled={props.busy}
                            aria-expanded={variantMenuOpen()}
                          >
                            <span>Thinking</span>
                            <span class="font-mono text-dls-text">{props.modelVariantLabel}</span>
                            <ChevronDown size={14} />
                          </button>
                          <Show when={variantMenuOpen()}>
                            <div class="absolute left-0 bottom-full mb-2 w-48 rounded-xl border border-dls-border bg-dls-surface shadow-xl backdrop-blur-md overflow-hidden z-40">
                              <div class="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-dls-secondary border-b border-dls-border">
                                Thinking effort
                              </div>
                              <div class="p-2 space-y-1">
                                <For each={MODEL_VARIANT_OPTIONS}>
                                  {(option) => (
                                    <button
                                      type="button"
                                      class={`w-full flex items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${activeVariant() === option.value
                                        ? "bg-dls-active text-dls-text"
                                        : "text-dls-secondary hover:bg-dls-hover"
                                        }`}
                                      onClick={() => {
                                        props.onModelVariantChange(option.value);
                                        setVariantMenuOpen(false);
                                      }}
                                    >
                                      <span>{option.label}</span>
                                      <Show when={activeVariant() === option.value}>
                                        <span class="text-[10px] uppercase tracking-wider text-dls-secondary">Active</span>
                                      </Show>
                                    </button>
                                  )}
                                </For>
                              </div>
                            </div>
                          </Show>
                        </div>
                      </div>
                      <div class="flex items-center gap-3 text-dls-secondary">
                        <Show
                          when={props.isStreaming}
                          fallback={
                            <button
                              type="button"
                              disabled={!hasDraftContent()}
                              onClick={sendDraft}
                              class={`p-1.5 rounded-full transition-colors ${!hasDraftContent()
                                ? "bg-dls-active text-dls-secondary"
                                : "bg-dls-accent text-white"
                                }`}
                              title="Send"
                            >
                              <ArrowUp size={18} />
                            </button>
                          }
                        >
                          <button
                            type="button"
                            onClick={() => props.onStop()}
                            class="p-1.5 rounded-full bg-gray-12 text-gray-1 hover:bg-gray-11 transition-colors"
                            title="Stop"
                          >
                            <Square size={14} fill="currentColor" />
                          </button>
                        </Show>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
