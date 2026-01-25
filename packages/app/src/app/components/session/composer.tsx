import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { Agent } from "@opencode-ai/sdk/v2/client";
import { ArrowRight, AtSign, File, Paperclip, Terminal, X, Zap } from "lucide-solid";

import type { ComposerAttachment, ComposerDraft, ComposerPart, PromptMode } from "../../types";

export type CommandItem = {
  id: string;
  description: string;
  needsArgs?: boolean;
};

type MentionOption = {
  id: string;
  kind: "agent" | "file";
  label: string;
  value: string;
  detail?: string;
};

type MentionSection = {
  title: string;
  options: MentionOption[];
};

type ComposerProps = {
  prompt: string;
  busy: boolean;
  onSend: (draft: ComposerDraft) => void;
  onDraftChange: (draft: ComposerDraft) => void;
  commandMatches: CommandItem[];
  onRunCommand: (commandId: string) => void;
  onInsertCommand: (commandId: string) => void;
  selectedModelLabel: string;
  onModelClick: () => void;
  modelSelectionRequired: boolean;
  showNotionBanner: boolean;
  onNotionBannerClick: () => void;
  toast: string | null;
  onToast: (message: string) => void;
  listAgents: () => Promise<Agent[]>;
  recentFiles: string[];
  searchFiles: (query: string) => Promise<string[]>;
  isRemoteWorkspace: boolean;
};

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const isImageMime = (mime: string) => mime.startsWith("image/");

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

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const normalizeText = (value: string) => value.replace(/\u00a0/g, " ");

const partsToText = (parts: ComposerPart[]) =>
  parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "agent") return `@${part.name}`;
      return `@${part.label ?? part.path}`;
    })
    .join("");

const createMentionSpan = (part: Extract<ComposerPart, { type: "agent" | "file" }>) => {
  const span = document.createElement("span");
  const label = part.type === "agent" ? part.name : part.label ?? part.path;
  span.textContent = `@${label}`;
  span.contentEditable = "false";
  span.dataset.mentionKind = part.type;
  span.dataset.mentionValue = part.type === "agent" ? part.name : part.path;
  span.dataset.mentionLabel = label;
  span.className =
    "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-gray-12/10 text-gray-12 border border-gray-6/70";
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

const buildPartsFromEditor = (root: HTMLElement): ComposerPart[] => {
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
  const [commandIndex, setCommandIndex] = createSignal(0);
  const [mentionIndex, setMentionIndex] = createSignal(0);
  const [mentionQuery, setMentionQuery] = createSignal("");
  const [mentionOpen, setMentionOpen] = createSignal(false);
  const [agentOptions, setAgentOptions] = createSignal<Agent[]>([]);
  const [agentLoaded, setAgentLoaded] = createSignal(false);
  const [searchResults, setSearchResults] = createSignal<string[]>([]);
  const [searchLoading, setSearchLoading] = createSignal(false);
  const [attachments, setAttachments] = createSignal<ComposerAttachment[]>([]);
  const [mode, setMode] = createSignal<PromptMode>("prompt");
  const [historySnapshot, setHistorySnapshot] = createSignal<ComposerDraft | null>(null);
  const [historyIndex, setHistoryIndex] = createSignal({ prompt: -1, shell: -1 });
  const [history, setHistory] = createSignal({ prompt: [] as ComposerDraft[], shell: [] as ComposerDraft[] });

  const commandMenuOpen = createMemo(() => {
    return props.prompt.trim().startsWith("/") && !props.busy && mode() === "prompt" && !mentionOpen();
  });

  const mentionSections = createMemo<MentionSection[]>(() => {
    if (!mentionOpen()) return [];
    const query = mentionQuery().trim().toLowerCase();
    const agents = agentOptions()
      .filter((agent: Agent) => {
        if (!query) return true;
        return agent.name.toLowerCase().includes(query);
      })
      .map((agent: Agent) => ({
        id: `agent:${agent.name}`,
        kind: "agent" as const,
        label: agent.name,
        value: agent.name,
      }));

    const recentFiles = props.recentFiles
      .filter((file: string) => {
        if (!query) return true;
        return file.toLowerCase().includes(query);
      })
      .map((file: string) => ({
        id: `file:${file}`,
        kind: "file" as const,
        label: file.split(/[/\\]/).pop() ?? file,
        value: file,
        detail: file,
      }));

    const searchFiles = searchResults()
      .filter((file: string) => file && !recentFiles.find((recent) => recent.value === file))
      .map((file: string) => ({
        id: `search:${file}`,
        kind: "file" as const,
        label: file.split(/[/\\]/).pop() ?? file,
        value: file,
        detail: file,
      }));

    const sections: MentionSection[] = [];
    if (agents.length) sections.push({ title: "Agents", options: agents });
    if (recentFiles.length) sections.push({ title: "Recent files", options: recentFiles });
    if (searchFiles.length) sections.push({ title: "Search results", options: searchFiles });
    if (!searchFiles.length && query) {
      sections.push({
        title: "Use path",
        options: [
          {
            id: `manual:${query}`,
            kind: "file",
            label: query.split(/[/\\]/).pop() ?? query,
            value: query,
            detail: query,
          },
        ],
      });
    }
    return sections;
  });

  const mentionOptions = createMemo(() =>
    mentionSections().flatMap((section: MentionSection) => section.options)
  );

  const syncHeight = () => {
    if (!editorRef) return;
    editorRef.style.height = "auto";
    const nextHeight = Math.min(editorRef.scrollHeight, 160);
    editorRef.style.height = `${nextHeight}px`;
    editorRef.style.overflowY = editorRef.scrollHeight > 160 ? "auto" : "hidden";
  };

  const emitDraftChange = () => {
    if (!editorRef) return;
    const parts = buildPartsFromEditor(editorRef);
    const text = normalizeText(partsToText(parts));
    props.onDraftChange({
      mode: mode(),
      parts,
      attachments: attachments(),
      text,
    });
    syncHeight();
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
      const span = createMentionSpan(part);
      editorRef?.appendChild(span);
      editorRef?.appendChild(document.createTextNode(" "));
    });
    if (selection) {
      restoreSelectionOffsets(editorRef, selection);
    }
    syncHeight();
  };

  const setEditorText = (value: string) => {
    if (!editorRef) return;
    renderParts(value ? [{ type: "text", text: value }] : [], false);
  };

  const updateMentionQuery = () => {
    if (!editorRef) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      setMentionOpen(false);
      return;
    }
    const range = selection.getRangeAt(0);
    const beforeRange = range.cloneRange();
    beforeRange.selectNodeContents(editorRef);
    beforeRange.setEnd(range.endContainer, range.endOffset);
    const beforeText = normalizeText(beforeRange.toString());
    const atIndex = beforeText.lastIndexOf("@");
    if (atIndex === -1) {
      setMentionOpen(false);
      return;
    }
    const query = beforeText.slice(atIndex + 1);
    if (/\s/.test(query)) {
      setMentionOpen(false);
      return;
    }
    setMentionQuery(query);
    setMentionOpen(true);
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
    const atIndex = beforeText.lastIndexOf("@");
    if (atIndex === -1) return;
    const start = atIndex;
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
      const parts = editorRef ? buildPartsFromEditor(editorRef) : [];
      const text = normalizeText(partsToText(parts));
      setHistorySnapshot({ mode: key, parts, attachments: attachments(), text });
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
    if (props.isRemoteWorkspace) {
      props.onToast("Attachments are unavailable in remote workspaces.");
      return;
    }
    const next: ComposerAttachment[] = [];
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        props.onToast(`${file.name} exceeds the 8MB limit.`);
        continue;
      }
      try {
        const dataUrl = await fileToDataUrl(file);
        next.push({
          id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          kind: isImageMime(file.type) ? "image" : "file",
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

  const handlePaste = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    const files = Array.from(event.clipboardData.files || []);
    if (!files.length) return;
    event.preventDefault();
    void addAttachments(files);
  };

  const handleDrop = (event: DragEvent) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length) void addAttachments(files);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      document.execCommand("insertLineBreak");
      emitDraftChange();
      return;
    }
    if (event.isComposing && event.key !== "Enter") return;

    if (mentionOpen()) {
      const options = mentionOptions();
      if (event.key === "Enter") {
        event.preventDefault();
        const active = options[mentionIndex()] ?? options[0];
        if (active) insertMention(active);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((i: number) => clamp(i + 1, 0, options.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((i: number) => clamp(i - 1, 0, options.length - 1));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionOpen(false);
        setMentionQuery("");
        return;
      }
    }

    if (commandMenuOpen()) {
      const matches = props.commandMatches;
      if (event.key === "Enter") {
        event.preventDefault();
        const active = matches[commandIndex()] ?? matches[0];
        if (active) {
          const hasArgs = /\s+/.test(props.prompt.trim());
          if (active.needsArgs && !hasArgs) {
            props.onInsertCommand(active.id);
          } else {
            props.onRunCommand(active.id);
          }
        }
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCommandIndex((i: number) => Math.min(i + 1, matches.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCommandIndex((i: number) => Math.max(i - 1, 0));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setEditorText("");
        emitDraftChange();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const active = matches[commandIndex()] ?? matches[0];
        if (active) {
          props.onInsertCommand(active.id);
        }
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
      if (props.modelSelectionRequired) {
        props.onToast("Select a model before sending a prompt.");
        props.onModelClick();
        return;
      }
      if (!editorRef) return;
      const parts = buildPartsFromEditor(editorRef);
      const text = normalizeText(partsToText(parts));
      const draft: ComposerDraft = { mode: mode(), parts, attachments: attachments(), text };
      recordHistory(draft);
      props.onSend(draft);
    }
  };

  createEffect(() => {
    if (commandMenuOpen()) {
      setCommandIndex(0);
    }
  });

  createEffect(() => {
    if (mentionOpen()) {
      setMentionIndex(0);
    }
  });

  createEffect(() => {
    if (!mentionOpen() || agentLoaded()) return;
    props
      .listAgents()
      .then((agents) => setAgentOptions(agents))
      .catch(() => setAgentOptions([]))
      .finally(() => setAgentLoaded(true));
  });

  createEffect(() => {
    if (!mentionOpen()) return;
    const query = mentionQuery().trim();
    if (!query) {
      setSearchResults([]);
      return;
    }
    setSearchLoading(true);
    const timeout = window.setTimeout(() => {
      props
        .searchFiles(query)
        .then((results) => setSearchResults(results))
        .catch(() => setSearchResults([]))
        .finally(() => setSearchLoading(false));
    }, 150);
    onCleanup(() => window.clearTimeout(timeout));
  });

  createEffect(() => {
    if (!editorRef) return;
    const value = props.prompt;
    const current = normalizeText(editorRef.innerText);
    if (value === current) return;
    if (value.startsWith("!") && mode() === "prompt") {
      setMode("shell");
      setEditorText(value.slice(1).trimStart());
      emitDraftChange();
      return;
    }
    setEditorText(value);
    if (!value) {
      setAttachments([]);
      setHistoryIndex((currentIndex: { prompt: number; shell: number }) => ({ ...currentIndex, [mode()]: -1 }));
      setHistorySnapshot(null);
    }
    emitDraftChange();
  });

  createEffect(() => {
    const handler = () => {
      editorRef?.focus();
    };
    window.addEventListener("openwork:focusPrompt", handler);
    onCleanup(() => window.removeEventListener("openwork:focusPrompt", handler));
  });

  const modeLabel = createMemo(() => (mode() === "shell" ? "Shell" : "Prompt"));

  return (
    <div class="p-4 border-t border-gray-6 bg-gray-1 sticky bottom-0 z-20">
      <div class="max-w-2xl mx-auto">
        <div
          class={`bg-gray-2 border border-gray-6 rounded-3xl overflow-visible transition-all shadow-2xl relative group/input ${
            commandMenuOpen() || mentionOpen()
              ? "rounded-t-none border-t-transparent"
              : "focus-within:ring-1 focus-within:ring-gray-7"
          }`}
          onDrop={handleDrop}
          onDragOver={(event: DragEvent) => {
            if (!props.isRemoteWorkspace) event.preventDefault();
          }}
        >
          <Show when={commandMenuOpen()}>
            <div class="absolute bottom-full left-[-1px] right-[-1px] z-30">
              <div class="rounded-t-3xl border border-gray-6 border-b-0 bg-gray-2 shadow-2xl overflow-hidden">
                <div class="px-4 pt-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-8 border-b border-gray-6/30 bg-gray-2">
                  Commands
                </div>
                <div class="space-y-1 p-2 bg-gray-2">
                  <Show
                    when={props.commandMatches.length}
                    fallback={<div class="px-3 py-2 text-xs text-gray-9">No commands found.</div>}
                  >
                    <For each={props.commandMatches}>
                      {(command: CommandItem, idx: () => number) => (
                        <button
                          type="button"
                          class={`w-full flex items-start gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
                            idx() === commandIndex()
                              ? "bg-gray-12/10 text-gray-12"
                              : "text-gray-11 hover:bg-gray-12/5"
                          }`}
                          onMouseDown={(e: MouseEvent) => {
                            e.preventDefault();
                            if (command.needsArgs) {
                              props.onInsertCommand(command.id);
                            } else {
                              props.onRunCommand(command.id);
                            }
                          }}
                          onMouseEnter={() => setCommandIndex(idx())}
                        >
                          <div class="text-xs font-semibold text-gray-12">/{command.id}</div>
                          <div class="text-[11px] text-gray-9">{command.description}</div>
                        </button>
                      )}
                    </For>
                  </Show>
                </div>
              </div>
            </div>
          </Show>

          <Show when={mentionOpen()}>
            <div class="absolute bottom-full left-[-1px] right-[-1px] z-30">
              <div class="rounded-t-3xl border border-gray-6 border-b-0 bg-gray-2 shadow-2xl overflow-hidden">
                <div class="px-4 pt-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-8 border-b border-gray-6/30 bg-gray-2 flex items-center gap-2">
                  <AtSign size={12} />
                  Mentions
                </div>
                <div class="space-y-3 p-3 bg-gray-2 max-h-64 overflow-y-auto">
                  <Show
                    when={mentionOptions().length}
                    fallback={
                      <div class="px-3 py-2 text-xs text-gray-9">
                        {searchLoading() ? "Searching files..." : "No matches found."}
                      </div>
                    }
                  >
                    <For each={mentionSections()}>
                      {(section: MentionSection) => (
                        <div>
                          <div class="px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-gray-8">
                            {section.title}
                          </div>
                          <div class="space-y-1">
                            <For each={section.options}>
                              {(option: MentionOption) => {
                                const optionIndex = createMemo(() => mentionOptions().findIndex((item) => item.id === option.id));
                                return (
                                  <button
                                    type="button"
                                    class={`w-full flex items-start gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
                                      optionIndex() === mentionIndex()
                                        ? "bg-gray-12/10 text-gray-12"
                                        : "text-gray-11 hover:bg-gray-12/5"
                                    }`}
                                    onMouseDown={(e: MouseEvent) => {
                                      e.preventDefault();
                                      insertMention(option);
                                    }}
                                    onMouseEnter={() => setMentionIndex(optionIndex())}
                                  >
                                    <div class="text-xs font-semibold text-gray-12">
                                      {option.kind === "agent" ? `@${option.label}` : option.label}
                                    </div>
                                    <Show when={option.detail}>
                                      <div class="text-[11px] text-gray-9">{option.detail}</div>
                                    </Show>
                                  </button>
                                );
                              }}
                            </For>
                          </div>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              </div>
            </div>
          </Show>

          <button
            type="button"
            class="absolute top-3 left-4 flex items-center gap-1.5 text-[10px] font-bold text-gray-7 hover:text-gray-11 transition-colors uppercase tracking-widest z-10"
            onClick={props.onModelClick}
            disabled={props.busy}
          >
            <Zap size={10} class="text-gray-7 group-hover:text-amber-11 transition-colors" />
            <span>{props.selectedModelLabel}</span>
          </button>

          <div class="p-3 pt-8 pb-3 px-4">
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
                    <div class="flex items-center gap-2 rounded-2xl border border-gray-6 bg-gray-1/70 px-3 py-2 text-xs text-gray-11">
                      <Show
                        when={attachment.kind === "image"}
                        fallback={<File size={14} class="text-gray-9" />}
                      >
                        <div class="h-10 w-10 rounded-xl bg-gray-2 overflow-hidden border border-gray-6">
                          <img src={attachment.dataUrl} alt={attachment.name} class="h-full w-full object-cover" />
                        </div>
                      </Show>
                      <div class="max-w-[160px]">
                        <div class="truncate text-gray-12">{attachment.name}</div>
                        <div class="text-[10px] text-gray-9">
                          {attachment.kind === "image" ? "Image" : attachment.mimeType || "File"}
                        </div>
                      </div>
                      <button
                        type="button"
                        class="ml-1 rounded-full p-1 text-gray-9 hover:text-gray-12 hover:bg-gray-12/10"
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

            <div class="relative">
              <Show when={props.toast}>
                <div class="absolute bottom-full right-0 mb-2 z-30 rounded-xl border border-gray-6 bg-gray-1/90 px-3 py-2 text-xs text-gray-11 shadow-lg backdrop-blur-md">
                  {props.toast}
                </div>
              </Show>

              <div class="flex items-end gap-3">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-2">
                    <div
                      class={`flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide border ${
                        mode() === "shell"
                          ? "border-amber-7/30 bg-amber-7/10 text-amber-12"
                          : "border-gray-6 bg-gray-1/70 text-gray-9"
                      }`}
                    >
                      <Terminal size={11} />
                      <span>{modeLabel()}</span>
                    </div>
                    <Show when={props.isRemoteWorkspace}>
                      <div class="text-[10px] uppercase tracking-wider text-gray-8">Remote workspace</div>
                    </Show>
                  </div>

                  <div class="relative">
                    <Show when={!props.prompt.trim() && !attachments().length}>
                      <div class="absolute left-0 top-0 text-gray-6 text-[15px] leading-relaxed pointer-events-none">
                        Ask OpenWork...
                      </div>
                    </Show>
                    <div
                      ref={editorRef}
                      contentEditable={!props.busy}
                      role="textbox"
                      aria-multiline="true"
                      onInput={() => {
                        updateMentionQuery();
                        emitDraftChange();
                      }}
                      onKeyDown={handleKeyDown}
                      onKeyUp={updateMentionQuery}
                      onClick={updateMentionQuery}
                      onPaste={handlePaste}
                      class="bg-transparent border-none p-0 text-gray-12 focus:ring-0 text-[15px] leading-relaxed resize-none min-h-[24px] outline-none relative z-10"
                    />
                  </div>
                </div>

                <div class="flex items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    class="hidden"
                    onChange={(event: Event) => {
                      const target = event.currentTarget as HTMLInputElement;
                      const files = Array.from(target.files ?? []);
                      if (files.length) void addAttachments(files);
                      target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    class="p-2 rounded-xl border border-gray-6 text-gray-10 hover:text-gray-12 hover:border-gray-7 transition-colors"
                    onClick={() => {
                      if (props.isRemoteWorkspace) {
                        props.onToast("Attachments are unavailable in remote workspaces.");
                        return;
                      }
                      fileInputRef?.click();
                    }}
                    title="Attach files"
                  >
                    <Paperclip size={16} />
                  </button>

                  <button
                    disabled={props.modelSelectionRequired || (!props.prompt.trim() && !attachments().length)}
                    onClick={() => {
                      if (props.modelSelectionRequired) {
                        props.onToast("Select a model before sending a prompt.");
                        props.onModelClick();
                        return;
                      }
                      if (!editorRef) return;
                      const parts = buildPartsFromEditor(editorRef);
                      const text = normalizeText(partsToText(parts));
                      const draft: ComposerDraft = { mode: mode(), parts, attachments: attachments(), text };
                      recordHistory(draft);
                      props.onSend(draft);
                    }}
                    class="p-2 bg-gray-12 text-gray-1 rounded-xl hover:scale-105 active:scale-95 transition-all disabled:opacity-0 disabled:scale-75 shadow-lg shrink-0 flex items-center justify-center"
                    title={props.modelSelectionRequired ? "Select a model" : "Run"}
                  >
                    <ArrowRight size={18} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
