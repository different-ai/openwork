/** @jsxImportSource react */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { isToolUIPart, type DynamicToolUIPart, type UIMessage } from "ai";
import type { Part } from "@opencode-ai/sdk/v2/client";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Box,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  File as FileIcon,
  Folder,
  GitFork,
  Globe,
  Search,
  Terminal,
  Undo2,
} from "lucide-react";

import { openDesktopPath, revealDesktopItemInDir } from "../../../../app/lib/desktop";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX,
  type MessageGroup,
  type StepGroupMode,
} from "../../../../app/types";
import { groupMessageParts, isDesktopRuntime, summarizeStep } from "../../../../app/utils";
import { DEFAULT_SHOW_THINKING } from "../../../kernel/local-provider";
import { MarkdownBlock } from "./markdown";
import { applyTextHighlights } from "./text-highlights";
import {
  deriveOpenTargets,
  isCollectibleArtifactTarget,
  isLocalhostBrowserTarget,
  type OpenTarget,
} from "../artifacts/open-target";

type TranscriptPart = Part;

type TranscriptMessage = {
  id: string;
  role: UIMessage["role"];
  source: UIMessage;
  parts: TranscriptPart[];
};

type StepTimelineGroup = {
  id: string;
  parts: TranscriptPart[];
  mode: StepGroupMode;
};

type StepClusterBlock = {
  kind: "steps-cluster";
  id: string;
  stepGroups: StepTimelineGroup[];
  messageIds: string[];
  isUser: boolean;
};

type MessageBlock = {
  kind: "message";
  message: UIMessage;
  renderableParts: TranscriptPart[];
  attachments: Array<{
    url: string;
    filename: string;
    mime: string;
  }>;
  groups: MessageGroup[];
  isUser: boolean;
  messageId: string;
};

type MessageBlockItem = MessageBlock | StepClusterBlock;

/**
 * Stable-key used to match a block across renders. For message blocks the
 * messageId is stable. For step clusters we reuse the cluster id (which is
 * derived from its first step group) as the identity anchor.
 */
function blockIdentityKey(block: MessageBlockItem): string {
  if (block.kind === "steps-cluster") return `cluster:${block.id}`;
  return `msg:${block.messageId}`;
}

/**
 * Returns true when a newly-computed block is content-equivalent to the
 * previous block we rendered under the same identity key. We compare the
 * underlying UIMessage reference (`message.source`) for message blocks and
 * the messageIds array + stepGroups identity for step clusters. If equal,
 * the caller reuses the previous block reference so React.memo'd children
 * downstream can skip work.
 *
 * This is the structural-sharing trick from T3Tools' MessagesTimeline: on
 * every streaming token, `props.messages` is a fresh array, but only the
 * *currently-streaming* message has a new `source` reference — everything
 * else is still pointer-equal to last tick. Rebuilding blocks from the new
 * array gives fresh block objects for every message, so downstream memo
 * checks all fail by default. Reusing the previous block reference when
 * its content hasn't actually changed gives every non-streaming row a free
 * bailout during a streaming burst.
 */
function blocksAreEquivalent(
  previous: MessageBlockItem | undefined,
  next: MessageBlockItem,
): boolean {
  if (!previous) return false;
  if (previous.kind !== next.kind) return false;
  if (previous.isUser !== next.isUser) return false;

  if (previous.kind === "steps-cluster" && next.kind === "steps-cluster") {
    if (previous.id !== next.id) return false;
    if (previous.messageIds.length !== next.messageIds.length) return false;
    for (let i = 0; i < previous.messageIds.length; i += 1) {
      if (previous.messageIds[i] !== next.messageIds[i]) return false;
    }
    if (previous.stepGroups.length !== next.stepGroups.length) return false;
    for (let i = 0; i < previous.stepGroups.length; i += 1) {
      const prevGroup = previous.stepGroups[i];
      const nextGroup = next.stepGroups[i];
      if (!prevGroup || !nextGroup) return false;
      if (prevGroup.id !== nextGroup.id) return false;
      if (prevGroup.mode !== nextGroup.mode) return false;
      if (prevGroup.parts.length !== nextGroup.parts.length) return false;
      for (let p = 0; p < prevGroup.parts.length; p += 1) {
        if (prevGroup.parts[p] !== nextGroup.parts[p]) return false;
      }
    }
    return true;
  }

  if (previous.kind === "message" && next.kind === "message") {
    if (previous.messageId !== next.messageId) return false;
    // The single most important check. The session sync layer keeps
    // UIMessage references stable for every non-streaming message across
    // rerenders; only the actively-streaming message gets a fresh
    // `source` reference per token. If the source is pointer-equal, the
    // block hasn't changed and we can reuse the previous object.
    if (previous.message !== next.message) return false;
    if (previous.attachments.length !== next.attachments.length) return false;
    if (previous.renderableParts.length !== next.renderableParts.length) return false;
    if (previous.groups.length !== next.groups.length) return false;
    return true;
  }

  return false;
}

type SessionTranscriptProps = {
  messages: UIMessage[];
  isStreaming: boolean;
  developerMode: boolean;
  showThinking?: boolean;
  expandedStepIds?: Set<string>;
  onExpandedStepIdsChange?: (updater: (current: Set<string>) => Set<string>) => void;
  searchMatchMessageIds?: ReadonlySet<string>;
  activeSearchMessageId?: string | null;
  searchHighlightQuery?: string;
  scrollElement?: () => HTMLElement | null | undefined;
  setScrollToMessageById?: (
    handler: ((messageId: string, behavior?: ScrollBehavior) => boolean) | null,
  ) => void;
  footer?: ReactNode;
  variant?: "default" | "nested";
  /** Revert to this message (undo everything after it). */
  onRevertToMessage?: (messageId: string) => void;
  /** Fork the conversation at this message into a new session. */
  onForkAtMessage?: (messageId: string) => void;
  openTargets?: OpenTarget[];
  onOpenTarget?: (target: OpenTarget) => void;
};

// 500 was too high for real-world OpenWork sessions: a handful of giant
// messages (emails, legal docs, pasted transcripts) can still produce a
// massive DOM even when the block count is low. Lowering the threshold means
// we switch to react-virtual much earlier and keep the main thread lighter
// during workspace/session switches.
// Virtualize aggressively. A session with 20+ message blocks already pays
// more to render eagerly than to run the virtualizer, so there's no reason
// to defer. The only reason the threshold exists at all is to avoid the
// virtualizer's baseline overhead for tiny sessions.
const VIRTUALIZATION_THRESHOLD = 20;
const VIRTUAL_OVERSCAN = 4;

function clampVirtualEstimate(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function estimateTextBlockSize(text: string, isUser: boolean) {
  const explicitLines = text.split("\n").length;
  const wrappedLines = Math.ceil(text.length / (isUser ? 68 : 86));
  const markdownStructureLines = text
    .split("\n")
    .filter((line) => /^\s*([-*+]\s+|\d+\.\s+|>\s+|#{1,6}\s+|\|)/.test(line)).length;
  const fencedCodeBlocks = Math.floor((text.match(/```/g) ?? []).length / 2);
  const estimatedLines = Math.max(explicitLines, wrappedLines) + markdownStructureLines * 0.5;
  const base = isUser ? 76 : 160;
  return base + estimatedLines * 22 + fencedCodeBlocks * 72;
}

function estimateBlockSize(block: MessageBlockItem | undefined) {
  if (!block) return 360;

  if (block.kind === "steps-cluster") {
    const partCount = block.stepGroups.reduce((total, group) => total + group.parts.length, 0);
    return clampVirtualEstimate(64 + partCount * 58, 96, 900);
  }

  const textSize = block.groups.reduce((total, group) => {
    if (group.kind === "steps") {
      return total + 72 + group.parts.length * 58;
    }
    return total + estimateTextBlockSize(partToText(group.part), block.isUser);
  }, 0);
  const attachmentSize = block.attachments.length > 0 ? 76 : 0;
  const openTargetsSize = !block.isUser ? 44 : 0;
  const actionsSize = block.isUser ? 24 : 36;

  return clampVirtualEstimate(
    textSize + attachmentSize + openTargetsSize + actionsSize,
    block.isUser ? 112 : 260,
    block.isUser ? 720 : 1800,
  );
}

function partIdFromUiPart(part: UIMessage["parts"][number], fallbackId: string) {
  const metadata = (part as { providerMetadata?: { opencode?: { partId?: unknown } } })
    .providerMetadata?.opencode;
  if (typeof metadata?.partId === "string" && metadata.partId.trim()) {
    return metadata.partId;
  }
  return fallbackId;
}

function toDynamicToolPart(part: UIMessage["parts"][number]) {
  if (part.type === "dynamic-tool") {
    return part;
  }
  if (!isToolUIPart(part)) return null;
  return {
    ...part,
    toolName: part.type.replace(/^tool-/, ""),
    type: "dynamic-tool",
  } as DynamicToolUIPart;
}

function toLegacyPart(
  part: UIMessage["parts"][number],
  fallbackId: string,
): TranscriptPart | null {
  const id = partIdFromUiPart(part, fallbackId);

  if (part.type === "text") {
    return { id, type: "text", text: part.text } as TranscriptPart;
  }

  if (part.type === "reasoning") {
    return { id, type: "reasoning", text: part.text } as TranscriptPart;
  }

  if (part.type === "file") {
    return {
      id,
      type: "file",
      url: part.url,
      filename: part.filename,
      mime: part.mediaType,
    } as TranscriptPart;
  }

  if (part.type === "step-start") {
    return { id, type: "step-start" } as TranscriptPart;
  }

  const toolPart = toDynamicToolPart(part);
  if (toolPart) {
    const state: Record<string, unknown> = {
      input: toolPart.input,
    };

    if (toolPart.state === "output-available") {
      state.output = toolPart.output;
    }

    if (toolPart.state === "output-error") {
      state.error = toolPart.errorText;
    }

    return {
      id: toolPart.toolCallId || id,
      type: "tool",
      tool: toolPart.toolName,
      state,
    } as TranscriptPart;
  }

  return null;
}

function isAttachmentPart(part: TranscriptPart) {
  if (part.type !== "file") return false;
  const url = (part as { url?: string }).url;
  return typeof url === "string" && !url.startsWith("file://");
}

function attachmentsForParts(parts: TranscriptPart[]) {
  return parts.flatMap((part) => {
      if (!isAttachmentPart(part)) return [];
      const record = part as {
        url?: string;
        filename?: string;
        mime?: string;
      };
      const attachment = {
        url: record.url ?? "",
        filename: record.filename ?? "attachment",
        mime: record.mime ?? "application/octet-stream",
      };
      return attachment.url ? [attachment] : [];
    });
}

function partToText(part: TranscriptPart) {
  if (part.type === "text") {
    return String((part as { text?: string }).text ?? "");
  }
  if (part.type === "reasoning") {
    return String((part as { text?: string }).text ?? "");
  }
  if (part.type === "agent") {
    const name = (part as { name?: string }).name ?? "";
    return name ? `@${name}` : "@agent";
  }
  if (part.type === "file") {
    const record = part as {
      label?: string;
      path?: string;
      filename?: string;
      url?: string;
    };
    const label = record.label ?? record.path ?? record.filename ?? record.url ?? "";
    return label ? `@${label}` : "@file";
  }
  if (part.type === "tool") {
    return summarizeStep(part).title;
  }
  return "";
}

function messageToText(message: UIMessage) {
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text];
      if (part.type === "reasoning") return [part.text];
      if (part.type === "file") return [part.filename ?? part.url];
      const toolPart = toDynamicToolPart(part);
      if (toolPart) {
        if (toolPart.state === "output-error") {
          return [`[tool:${toolPart.toolName}] ${toolPart.errorText}`];
        }
        if (toolPart.state === "output-available") {
          return [`[tool:${toolPart.toolName}] ${JSON.stringify(toolPart.output)}`];
        }
        return [`[tool:${toolPart.toolName}] ${JSON.stringify(toolPart.input)}`];
      }
      return [];
    })
    .join("\n\n")
    .trim();
}

function isImageAttachment(mime: string) {
  return mime.startsWith("image/");
}

function humanMediaType(raw: string) {
  if (!raw || raw === "application/octet-stream") return null;
  const short = raw.replace(/^application\//, "").replace(/^text\//, "");
  return short.toUpperCase();
}

function cleanReasoningPreview(value: string) {
  const cleaned = value
    .replace(/\[REDACTED\]/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+\n/g, "\n")
    .trim();

  return cleaned
    .replace(/^(?:thinking|reasoning)\s*(?::|-|–|—)\s*/i, "")
    .replace(/^(?:thinking|reasoning)\s*\r?\n+/i, "")
    .trim();
}

function splitReasoningPreview(value: string) {
  const clean = cleanReasoningPreview(value);
  if (!clean) return { headline: "", body: "" };
  const lines = clean.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    return trimmed ? [trimmed] : [];
  });
  if (lines.length <= 1) return { headline: "", body: clean };
  return { headline: lines[0] ?? "", body: lines.slice(1).join("\n") };
}

function formatStructuredValue(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function hasStructuredValue(value: unknown) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return true;
}

function ToolActivityIcon(props: { category?: string }) {
  const className = "size-4 shrink-0 text-muted-foreground";
  switch (props.category) {
    case "terminal":
      return <Terminal className={className} strokeWidth={1.9} />;
    case "read":
    case "edit":
    case "write":
      return <FileIcon className={className} strokeWidth={1.9} />;
    case "glob":
      return <Folder className={className} strokeWidth={1.9} />;
    case "search":
      return <Search className={className} strokeWidth={1.9} />;
    default:
      return <Box className={className} strokeWidth={1.9} />;
  }
}

function toolStatusText(status?: string) {
  if (!status) return null;
  const normalized = status.toLowerCase();
  if (normalized.includes("approval") || normalized.includes("pending")) return "Awaiting approval";
  if (normalized.includes("running") || normalized.includes("progress")) return "In progress";
  if (normalized.includes("error") || normalized.includes("failed")) return "Failed";
  return null;
}

async function openFileWithOS(path: string) {
  try {
    await openDesktopPath(path);
  } catch {
    // silently fail on web
  }
}

async function revealFileInFinder(path: string) {
  try {
    await revealDesktopItemInDir(path);
  } catch {
    // silently fail on web
  }
}

function CopyButton(props: { getText: () => string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const label = props.label ?? "Copy message";

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title={label}
      aria-label={label}
      onClick={async () => {
        await navigator.clipboard.writeText(props.getText());
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </Button>
  );
}

/** Expandable chip for collapsed pasted text in sent messages. */
function PastedTextChip(props: { label: string; text: string }) {
  const [expanded, setExpanded] = useState(false);
  const lineCount = props.text.split(/\r?\n/).length;

  return (
    <span className="inline">
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-full border border-amber-6/35 bg-amber-3/15 px-2.5 py-0.5 text-xs font-medium text-amber-11 transition-colors hover:bg-amber-3/30"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? "Collapse pasted text" : "Expand pasted text"}
      >
        <ChevronDown
          size={12}
          className={cn("shrink-0 transition-transform", expanded && "rotate-180")}
        />
        <span>Pasted · {lineCount} line{lineCount === 1 ? "" : "s"}</span>
      </button>
      {expanded ? (
        <div className="mt-1.5 mb-1.5 rounded-xl border border-amber-6/20 bg-amber-3/10 px-4 py-3 text-xs leading-5 text-foreground">
          <pre className="whitespace-pre-wrap break-words font-mono">{props.text}</pre>
        </div>
      ) : null}
    </span>
  );
}

const PASTE_TOKEN_RE = /(\[pasted text [^\]]+\])/;

function HighlightedPlainText(props: {
  text: string;
  className: string;
  highlightQuery?: string;
  /** Map of paste label -> full text for expandable chips */
  pastedTextMap?: Map<string, string>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    queueMicrotask(() => {
      if (!rootRef.current || rootRef.current !== root) return;
      applyTextHighlights(root, props.highlightQuery ?? "");
    });
  }, [props.highlightQuery, props.text]);

  // If no paste tokens present, render as plain text (fast path).
  if (!props.pastedTextMap?.size || !PASTE_TOKEN_RE.test(props.text)) {
    return (
      <div ref={rootRef} className={props.className}>
        {props.text}
      </div>
    );
  }

  // Split on paste tokens and render chips inline.
  const segments = props.text.split(PASTE_TOKEN_RE);
  let segmentOffset = 0;
  return (
    <div ref={rootRef} className={props.className}>
      {segments.map((segment) => {
        const key = `${segmentOffset}:${segment}`;
        segmentOffset += segment.length;
        const match = segment.match(/^\[pasted text (.+)\]$/);
        if (match?.[1]) {
          const pastedBody = props.pastedTextMap?.get(match[1]);
          if (pastedBody) {
            return <PastedTextChip key={key} label={match[1]} text={pastedBody} />;
          }
        }
        return <span key={key}>{segment}</span>;
      })}
    </div>
  );
}

function FileCard(props: {
  part: { filename?: string; url: string; mediaType: string };
  tone: "assistant" | "user";
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isDataUrl = props.part.url?.startsWith("data:");
  const title = props.part.filename || (isDataUrl ? "Attached file" : props.part.url) || "File";
  const ext = props.part.filename?.split(".").pop()?.toLowerCase();
  const badge = humanMediaType(props.part.mediaType) ?? (ext ? ext.toUpperCase() : null);
  const isImage = isImageAttachment(props.part.mediaType ?? "");
  const isDesktop = isDesktopRuntime();
  const hasPath = !isDataUrl && props.part.url && !props.part.url.startsWith("http");

  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 rounded-2xl border px-4 py-3 transition-colors",
        props.tone === "user"
          ? "border-gray-6/60 bg-gray-2/40 hover:bg-gray-2/60"
          : "border-gray-6/40 bg-gray-1/40 hover:bg-gray-2/30",
      )}
    >
      {isImage && props.part.url ? (
        <div className="size-11 shrink-0 overflow-hidden rounded-xl border border-dls-border/60 bg-dls-surface">
          <img src={props.part.url} alt={title} loading="lazy" decoding="async" className="size-full object-cover" />
        </div>
      ) : (
        <div
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-xl",
            props.tone === "user" ? "bg-gray-3/60 text-foreground" : "bg-gray-2/60 text-muted-foreground",
          )}
        >
          <FileIcon size={20} />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium leading-snug text-foreground">{title}</div>
        {badge ? (
          <div className="mt-1 inline-flex rounded-md bg-gray-3/50 px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {badge}
          </div>
        ) : null}
      </div>

      {isDesktop && hasPath ? (
        <div className="relative">
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-xl text-muted-foreground opacity-0 transition-all hover:bg-gray-3/60 hover:text-foreground group-hover:opacity-100"
            onClick={() => setMenuOpen((value) => !value)}
            title="File actions"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
          </button>
          {menuOpen ? (
            <>
              <button type="button" className="fixed inset-0 z-30 cursor-default border-0 bg-transparent p-0" aria-label="Close file actions" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full z-40 mt-1 w-48 rounded-2xl border border-dls-border bg-dls-surface p-1.5 shadow-lg">
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-gray-3/60"
                  onClick={() => {
                    void openFileWithOS(props.part.url);
                    setMenuOpen(false);
                  }}
                >
                  Open with default app
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-gray-3/60"
                  onClick={() => {
                    void revealFileInFinder(props.part.url);
                    setMenuOpen(false);
                  }}
                >
                  Reveal in Finder
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-gray-3/60"
                  onClick={() => {
                    void navigator.clipboard.writeText(props.part.url);
                    setMenuOpen(false);
                  }}
                >
                  Copy path
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StepRow(props: {
  id: string;
  part: TranscriptPart;
  expanded: boolean;
  onToggle: () => void;
}) {
  const summary = useMemo(() => summarizeStep(props.part), [props.part]);
  const toolState = useMemo(() => {
    if (props.part.type !== "tool") return {} as Record<string, unknown>;
    return (((props.part as { state?: unknown }).state ?? {}) as Record<string, unknown>);
  }, [props.part]);
  const toolInput = toolState.input && typeof toolState.input === "object"
    ? (toolState.input as Record<string, unknown>)
    : undefined;
  const toolOutput = toolState.output;
  const toolError = typeof toolState.error === "string" ? toolState.error : null;
  const expandable =
    props.part.type === "tool" &&
    (hasStructuredValue(toolInput) || hasStructuredValue(toolOutput) || Boolean(toolError));
  const headline = summary.title?.trim() || "Step updates progress";
  const statusText = toolStatusText(summary.status);

  if (props.part.type === "reasoning") {
    const raw = typeof (props.part as { text?: unknown }).text === "string"
      ? (props.part as { text: string }).text
      : "";
    const preview = splitReasoningPreview(raw);
    if (!preview.headline && !preview.body) return null;

    return (
      <div
        data-reasoning="true"
        className="whitespace-pre-wrap font-sans text-sm leading-[1.65] text-muted-foreground antialiased"
      >
        <div className="max-w-[760px]">
          {preview.headline ? <div className="mb-2 text-muted-foreground">{preview.headline}</div> : null}
          <div>{preview.body || headline}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="font-sans text-sm leading-[1.65] antialiased">
      <button
        type="button"
        className="w-full text-left transition-colors hover:text-foreground disabled:cursor-default text-muted-foreground"
        aria-expanded={expandable ? props.expanded : undefined}
        disabled={!expandable}
        onClick={() => {
          if (!expandable) return;
          props.onToggle();
        }}
      >
        <span className="inline-flex max-w-[760px] items-center gap-3">
          <ToolActivityIcon category={summary.toolCategory} />
          <span className="min-w-0 wrap-break-word">{headline}</span>
          {expandable ? (
            <ChevronDown
              size={15}
              className={cn(
                "shrink-0 text-muted-foreground transition-transform",
                !props.expanded && "-rotate-90",
              )}
            />
          ) : null}
        </span>
      </button>
      {statusText ? <div className="ml-7 mt-2 text-sm leading-[1.65] text-muted-foreground">{statusText}</div> : null}
      {props.expanded ? (
        <div className="mt-3 ml-7 space-y-3">
          {hasStructuredValue(toolInput) ? (
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Request</div>
              <pre className="overflow-x-auto rounded-[16px] border border-dls-border/70 bg-dls-surface px-4 py-3 text-xs leading-6 text-muted-foreground">
                {formatStructuredValue(toolInput)}
              </pre>
            </div>
          ) : null}
          {hasStructuredValue(toolOutput) ? (
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Result</div>
              <pre className="overflow-x-auto rounded-[16px] border border-dls-border/70 bg-dls-surface px-4 py-3 text-xs leading-6 text-muted-foreground">
                {formatStructuredValue(toolOutput)}
              </pre>
            </div>
          ) : null}
          {toolError ? (
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Error</div>
              <pre className="overflow-x-auto rounded-[16px] border border-red-6/40 bg-red-3/20 px-4 py-3 text-xs leading-6 text-red-11">
                {toolError}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StepsContainer(props: {
  stepGroups: StepTimelineGroup[];
  isUser: boolean;
  isInline?: boolean;
  isNestedVariant: boolean;
  isActive: boolean;
  expandedStepIds: Set<string>;
  onExpandedStepIdsChange: (updater: (current: Set<string>) => Set<string>) => void;
}) {
  const toggleSteps = (id: string) => {
    props.onExpandedStepIdsChange((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div>
      <div
        data-scrollable={!props.isNestedVariant ? "true" : undefined}
        className={cn(!props.isNestedVariant && "max-h-[520px] overflow-y-auto pr-3")}
      >
        <div className="flex flex-col gap-7">
          {props.stepGroups.map((group) => (
            <div key={group.id} className="flex flex-col gap-7">
              {group.parts.map((part, index) => {
                const rowId = `${group.id}:${index}`;
                return (
                  <StepRow
                    key={rowId}
                    id={rowId}
                    part={part}
                    expanded={props.expandedStepIds.has(rowId)}
                    onToggle={() => toggleSteps(rowId)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function messageGroupKey(messageId: string, group: MessageGroup) {
  if (group.kind === "steps") return `${messageId}:steps:${group.id}`;
  const partId = "id" in group.part && typeof group.part.id === "string" ? group.part.id : partToText(group.part);
  return `${messageId}:text:${group.segment}:${partId}`;
}

function inlineOpenTargetsForMessage(message: UIMessage, verifiedTargets: OpenTarget[] | undefined) {
  const verifiedById = new Map((verifiedTargets ?? []).map((target) => [target.id, target] as const));
  const inlineTargets = new Map<string, OpenTarget>();
  for (const candidate of deriveOpenTargets([message], { includeFileMentions: true })) {
    const verified = verifiedById.get(candidate.id);
    if (candidate.kind === "url" && isLocalhostBrowserTarget(candidate)) {
      inlineTargets.set(candidate.id, verified ?? candidate);
      continue;
    }
    if (verified && isCollectibleArtifactTarget(verified)) {
      inlineTargets.set(verified.id, verified);
    }
  }
  return Array.from(inlineTargets.values()).slice(0, 4);
}

function OpenTargetIcon(props: { target: OpenTarget }) {
  if (props.target.kind === "url") {
    return <Globe size={12} className="shrink-0 text-muted-foreground" />;
  }

  if (props.target.preview === "sheet") {
    return (
      <span className="inline-flex h-3.5 min-w-5 shrink-0 items-center justify-center rounded-[3px] border border-emerald-500/30 bg-emerald-500/10 px-0.5 text-[6px] font-bold leading-none text-emerald-700">
        XLS
      </span>
    );
  }
  if (props.target.preview === "markdown") {
    return (
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border border-primary/25 bg-primary/10 text-[7px] font-bold leading-none text-primary">
        MD
      </span>
    );
  }

  return <FileIcon size={12} className="shrink-0 text-primary" />;
}

function OpenableTargetsStrip(props: { targets: OpenTarget[]; onOpenTarget: (target: OpenTarget) => void }) {
  if (!props.targets.length) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs leading-none">
      <span className="mr-0.5 text-muted-foreground">Openable items</span>
      {props.targets.map((target) => (
          <button
            key={target.id}
            type="button"
            className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-dls-border bg-dls-surface px-2 py-1.5 text-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
            title={target.value}
            onClick={() => props.onOpenTarget(target)}
          >
            <OpenTargetIcon target={target} />
            <span className="truncate">{target.name || target.value}</span>
            <span className="text-muted-foreground">{target.kind === "url" ? "Open browser" : "Open artifact"}</span>
          </button>
        ))}
    </div>
  );
}

function MessageBlockRow(props: {
  block: MessageBlockItem;
  blockIndex: number;
  totalBlocks: number;
  isNestedVariant: boolean;
  shouldUseContentVisibility: boolean;
  expandedStepIds: Set<string>;
  onExpandedStepIdsChange: (updater: (current: Set<string>) => Set<string>) => void;
  searchMatchMessageIds?: ReadonlySet<string>;
  activeSearchMessageId?: string | null;
  searchHighlightQuery?: string;
  isStreaming: boolean;
  latestAssistantMessageId: string;
  onRevertToMessage?: (messageId: string) => void;
  onForkAtMessage?: (messageId: string) => void;
  openTargets?: OpenTarget[];
  onOpenTarget?: (target: OpenTarget) => void;
}) {
  const block = props.block;
  const blockMessageIds = block.kind === "steps-cluster" ? block.messageIds : [block.messageId];
  const hasSearchMatch = blockMessageIds.some((id) => props.searchMatchMessageIds?.has(id));
  const hasActiveSearchMatch = blockMessageIds.some((id) => id === props.activeSearchMessageId);
  const searchOutlineClass = hasActiveSearchMatch
    ? "outline outline-2 outline-amber-8/70 outline-offset-2 rounded-2xl"
    : hasSearchMatch
      ? "outline outline-1 outline-amber-7/50 outline-offset-1 rounded-2xl"
      : "";
  const perfStyle = props.shouldUseContentVisibility && props.blockIndex < props.totalBlocks - 12
    ? { contentVisibility: "auto", containIntrinsicSize: "180px" } satisfies CSSProperties
    : undefined;

  if (block.kind === "steps-cluster") {
    return (
      <div
        className={cn("flex group justify-start pb-4", block.isUser && "justify-end")}
        data-message-role={block.isUser ? "user" : "assistant"}
        data-message-id={block.messageIds[0] ?? ""}
        style={{ contain: "layout style paint", ...perfStyle }}
      >
        <div
          className={cn(
            block.isUser
              ? props.isNestedVariant
                ? "relative max-w-[92%] rounded-[20px] border border-dls-border bg-dls-sidebar px-4 py-3 text-sm leading-relaxed text-foreground"
                : "relative max-w-[85%] rounded-[24px] border border-dls-border bg-dls-sidebar px-6 py-4 text-sm leading-relaxed text-foreground"
              : props.isNestedVariant
                ? "w-full relative text-sm leading-[1.65] text-foreground group"
                : "w-full relative max-w-[760px] text-sm leading-[1.7] text-foreground group",
            searchOutlineClass,
          )}
        >
          <StepsContainer
            stepGroups={block.stepGroups}
            isUser={block.isUser}
            isNestedVariant={props.isNestedVariant}
            isActive={props.isStreaming && block.messageIds.includes(props.latestAssistantMessageId)}
            expandedStepIds={props.expandedStepIds}
            onExpandedStepIdsChange={props.onExpandedStepIdsChange}
          />
        </div>
      </div>
    );
  }

  const groupSpacing = block.isUser ? "mb-3" : "mb-4";
  const isSyntheticSessionError =
    !block.isUser && block.messageId.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX);
  const inlineOpenTargets = block.kind === "message" && !block.isUser && props.onOpenTarget
    ? inlineOpenTargetsForMessage(block.message, props.openTargets)
    : [];

  if (isSyntheticSessionError) {
    const fullErrorText = block.renderableParts
      .map((part) => partToText(part))
      .join("\n")
      .trim();
    const messageText = fullErrorText
      .replace(/\s*\n+\s*/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    return (
      <div
        className="flex group justify-start pb-4"
        data-message-role="assistant"
        data-message-id={block.messageId}
        style={{ contain: "layout style paint", ...perfStyle }}
      >
        <div className={cn("w-full relative", !props.isNestedVariant && "max-w-[650px]", searchOutlineClass)}>
          <div
            className="inline-flex max-w-full items-start gap-2 rounded-[18px] border border-red-7/20 bg-red-1/35 py-2 pl-3 pr-2 text-sm leading-5 text-red-12 shadow-sm"
            role="alert"
          >
            <CircleAlert size={14} className="mt-0.5 shrink-0" />
            <div className="min-w-0 wrap-break-word pt-px">{messageText}</div>
            <div className="shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity">
              <CopyButton getText={() => fullErrorText} label="Copy error" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn("flex group justify-start relative pb-4", block.isUser && "justify-end", !props.isNestedVariant && "pb-8")}
      data-message-role={block.isUser ? "user" : "assistant"}
      data-message-id={block.messageId}
      style={{ contain: "layout style paint", ...perfStyle }}
    >
      <div
        className={cn(
          "text-sm text-foreground leading-relaxed",
          block.isUser && "border border-dls-border bg-dls-sidebar",
          block.isUser && props.isNestedVariant && "max-w-[92%] rounded-[20px] px-4 py-3",
          block.isUser && !props.isNestedVariant && "max-w-[85%] rounded-[24px] px-6 py-4",
          !block.isUser && "w-full antialiased group",
          !block.isUser && !props.isNestedVariant && "max-w-[760px]",
          searchOutlineClass,
        )}
      >
        {block.attachments.length > 0 ? (
          <div className={cn("flex flex-wrap gap-2", block.isUser ? "mb-3" : "mb-4")}>
            {block.attachments.map((attachment) => (
              <FileCard
                key={`${block.messageId}:${attachment.url}`}
                part={{
                  filename: attachment.filename,
                  url: attachment.url,
                  mediaType: attachment.mime,
                }}
                tone={block.isUser ? "user" : "assistant"}
              />
            ))}
          </div>
        ) : null}

        {block.groups.map((group) => {
          const highlightQuery = hasSearchMatch ? props.searchHighlightQuery : undefined;
          const isStreamingLatestAssistant =
            !block.isUser && props.isStreaming && block.messageId === props.latestAssistantMessageId;

          return (
            <div key={messageGroupKey(block.messageId, group)} className={cn(group !== block.groups.at(-1) && groupSpacing)}>
              {group.kind === "text" ? (() => {
                if (group.part.type === "file") {
                  const filePart = group.part as {
                    filename?: string;
                    url?: string;
                    mime?: string;
                  };
                  return (
                    <FileCard
                      part={{
                        filename: filePart.filename,
                        url: filePart.url ?? "",
                        mediaType: filePart.mime ?? "application/octet-stream",
                      }}
                      tone={block.isUser ? "user" : "assistant"}
                    />
                  );
                }

                const text = partToText(group.part);
                if (block.isUser) {
                  return (
                    <HighlightedPlainText
                      text={text}
                      className="whitespace-pre-wrap wrap-break-word text-foreground"
                      highlightQuery={highlightQuery}
                    />
                  );
                }

                return (
                  <MarkdownBlock
                    text={text}
                    streaming={isStreamingLatestAssistant}
                    highlightQuery={highlightQuery}
                  />
                );
              })() : null}

              {group.kind === "steps" ? (
                <StepsContainer
                  stepGroups={[{
                    id: group.id,
                    parts: group.parts,
                    mode: group.mode,
                  }]}
                  isUser={block.isUser}
                  isInline={true}
                  isNestedVariant={props.isNestedVariant}
                  isActive={isStreamingLatestAssistant}
                  expandedStepIds={props.expandedStepIds}
                  onExpandedStepIdsChange={props.onExpandedStepIdsChange}
                />
              ) : null}
            </div>
          );
        })}

        {props.onOpenTarget ? <OpenableTargetsStrip targets={inlineOpenTargets} onOpenTarget={props.onOpenTarget} /> : null}

        {!props.isNestedVariant ? (
          <div
            className={cn(
              "absolute bottom-2 flex items-center gap-0.5 opacity-100 pointer-events-auto md:opacity-0 md:pointer-events-none md:group-hover:opacity-100 md:group-hover:pointer-events-auto md:group-focus-within:opacity-100 md:group-focus-within:pointer-events-auto transition-opacity select-none",
              block.isUser ? "right-0" : "left-0",
            )}
          >
            {props.onRevertToMessage ? (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => props.onRevertToMessage?.(block.messageId)}
                title="Revert to here"
                aria-label="Revert to this message"
              >
                <Undo2 size={14} />
              </Button>
            ) : null}
            {props.onForkAtMessage ? (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => props.onForkAtMessage?.(block.messageId)}
                title="Fork from here"
                aria-label="Fork conversation from this message"
              >
                <GitFork size={14} />
              </Button>
            ) : null}
            <CopyButton getText={() => messageToText(block.message)} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SessionTranscriptInner(props: SessionTranscriptProps) {
  const showThinking = props.showThinking ?? DEFAULT_SHOW_THINKING;
  const isNestedVariant = props.variant === "nested";
  const [internalExpandedStepIds, setInternalExpandedStepIds] = useState<Set<string>>(
    () => new Set(),
  );
  const expandedStepIds = props.expandedStepIds ?? internalExpandedStepIds;
  const onExpandedStepIdsChange =
    props.onExpandedStepIdsChange ??
    ((updater: (current: Set<string>) => Set<string>) => {
      setInternalExpandedStepIds((current) => updater(current));
    });

  const transcriptMessages = useMemo<TranscriptMessage[]>(() => {
    return props.messages.map((message) => ({
      id: message.id,
      role: message.role,
      source: message,
      parts: message.parts.flatMap((part, index) => {
        const legacyPart = toLegacyPart(part, `${message.id}:${index}`);
        return legacyPart ? [legacyPart] : [];
      }),
    }));
  }, [props.messages]);

  // Cache of the previous messageBlocks array, indexed by identity key.
  // Used by useStableBlocks below so structurally-equivalent blocks keep
  // their previous object reference across renders.
  const previousBlocksRef = useRef<Map<string, MessageBlockItem>>(new Map());

  const rawMessageBlocks = useMemo<MessageBlockItem[]>(() => {
    const blocks: MessageBlockItem[] = [];

    transcriptMessages.forEach((message) => {
      const renderableParts = message.parts.filter((part) => {
        if (part.type === "reasoning") {
          return showThinking;
        }

        if (part.type === "step-start" || part.type === "step-finish") {
          return false;
        }

        return (
          part.type === "text" ||
          part.type === "tool" ||
          part.type === "agent" ||
          part.type === "file" ||
          props.developerMode
        );
      });

      if (!renderableParts.length) return;

      const isUser = message.role === "user";
      const attachments = attachmentsForParts(renderableParts);
      const nonAttachmentParts = renderableParts.filter((part) => !isAttachmentPart(part));
      const groups = groupMessageParts(nonAttachmentParts, message.id);
      const isStepsOnly = groups.length > 0 && groups.every((group) => group.kind === "steps");
      const stepGroups = isStepsOnly
        ? (groups as Array<{
            kind: "steps";
            id: string;
            parts: TranscriptPart[];
            segment: "execution";
            mode: StepGroupMode;
          }>).map((group) => ({
            id: group.id,
            parts: group.parts,
            mode: group.mode,
          }))
        : [];

      if (isStepsOnly && stepGroups.length > 0) {
        blocks.push({
          kind: "steps-cluster",
          id: stepGroups[0].id,
          stepGroups,
          messageIds: [message.id],
          isUser,
        });
        return;
      }

      blocks.push({
        kind: "message",
        message: message.source,
        renderableParts,
        attachments,
        groups,
        isUser,
        messageId: message.id,
      });
    });

    return blocks;
  }, [props.developerMode, showThinking, transcriptMessages]);

  // Structural sharing: reuse the previous block object reference for any
  // block whose content is equivalent. During streaming, only the active
  // assistant message's block is actually new — every other block in the
  // transcript keeps its previous reference, which means every
  // React.memo'd descendant (MarkdownBlock, SessionTranscript itself, and
  // any future per-row components) gets a pointer-equal prop and can bail
  // out of rendering entirely.
  const messageBlocks = useMemo<MessageBlockItem[]>(() => {
    const prev = previousBlocksRef.current;
    const next = new Map<string, MessageBlockItem>();
    const stable: MessageBlockItem[] = rawMessageBlocks.map((block) => {
      const key = blockIdentityKey(block);
      const prevBlock = prev.get(key);
      const reused = blocksAreEquivalent(prevBlock, block) ? (prevBlock as MessageBlockItem) : block;
      next.set(key, reused);
      return reused;
    });
    previousBlocksRef.current = next;
    return stable;
  }, [rawMessageBlocks]);

  const latestAssistantMessageId = useMemo(() => {
    for (let index = props.messages.length - 1; index >= 0; index -= 1) {
      const message = props.messages[index];
      if (message?.role === "assistant") {
        return message.id;
      }
    }
    return "";
  }, [props.messages]);

  const blockIndexByMessageId = useMemo(() => {
    const next = new Map<string, number>();
    messageBlocks.forEach((block, index) => {
      if (block.kind === "steps-cluster") {
        block.messageIds.forEach((id) => {
          if (id) next.set(id, index);
        });
        return;
      }

      if (block.messageId) {
        next.set(block.messageId, index);
      }
    });
    return next;
  }, [messageBlocks]);

  // Decide to virtualize based only on block count. Do NOT gate on whether
  // the scrollElement ref has already attached — that's false on the first
  // render of a session, which used to make us render every message
  // eagerly (freezing the UI on large sessions) for one tick before
  // switching to virtualization.
  const shouldVirtualize = messageBlocks.length >= VIRTUALIZATION_THRESHOLD;

  const estimateVirtualItemSize = useCallback(
    (index: number) => estimateBlockSize(messageBlocks[index]),
    [messageBlocks],
  );

  const getVirtualItemKey = useCallback((index: number) => {
    const block = messageBlocks[index];
    if (!block) return `block-${index}`;
    if (block.kind === "steps-cluster") {
      return `steps-${block.messageIds.join(",")}`;
    }
    return `message-${block.messageId}`;
  }, [messageBlocks]);

  const virtualizer = useVirtualizer({
    count: messageBlocks.length,
    getScrollElement: () => props.scrollElement?.() ?? null,
    // TanStack recommends estimating the largest comfortable dynamic size.
    // Content-aware estimates reduce the measurement corrections that cause
    // long transcripts to jitter as previously-unmeasured rows enter view.
    estimateSize: estimateVirtualItemSize,
    overscan: VIRTUAL_OVERSCAN,
    getItemKey: getVirtualItemKey,
  });

  const virtualRows = shouldVirtualize ? virtualizer.getVirtualItems() : [];
  const firstVirtualRow = virtualRows[0];

  useEffect(() => {
    const register = props.setScrollToMessageById;
    if (!register) return;

    register((messageId, behavior = "smooth") => {
      const index = blockIndexByMessageId.get(messageId);
      if (index === undefined) return false;

      if (shouldVirtualize) {
        virtualizer.scrollToIndex(index, { align: "center" });
        return true;
      }

      const container = props.scrollElement?.();
      if (!container) return false;
      const escapedId = messageId.replace(/"/g, '\\"');
      const target = container.querySelector(`[data-message-id="${escapedId}"]`) as HTMLElement | null;
      if (!target) return false;
      target.scrollIntoView({ behavior, block: "center" });
      return true;
    });

    return () => {
      register(null);
    };
  }, [blockIndexByMessageId, props.scrollElement, props.setScrollToMessageById, shouldVirtualize, virtualizer]);

  // NOTE: we intentionally do NOT call virtualizer.measure() on every
  // messageBlocks change. react-virtual already invalidates and
  // re-measures rows whose refs remount or whose content changes. Calling
  // measure() explicitly on each streaming token forces a synchronous
  // getBoundingClientRect() pass over every measured row, which made
  // streaming into large sessions feel like the UI was frozen.

  // Apply content-visibility earlier too. Even when the transcript is below
  // the virtualization threshold, hiding distant blocks from layout/paint
  // work reduces the chance that one large session makes the UI feel frozen.
  const shouldUseContentVisibility = !shouldVirtualize && messageBlocks.length > 24;

  return (
    <div className="pb-0" style={{ contain: "layout paint style" }}>
      {shouldVirtualize ? (
        // Always render the virtualized container once we've decided to
        // virtualize — even if virtualRows is empty on the very first tick
        // (e.g. scrollElement ref hasn't attached yet). A fallback to
        // rendering every message would re-introduce the eager-render
        // freeze on huge sessions.
        <div
          className="relative"
          style={{
            height: `${Math.max(virtualizer.getTotalSize(), 1)}px`,
            width: "100%",
          }}
        >
          {firstVirtualRow ? (
            <div
              className="absolute left-0 top-0 w-full"
              style={{
                transform: `translateY(${firstVirtualRow.start}px)`,
              }}
            >
              {virtualRows.map((virtualRow) => {
                const block = messageBlocks[virtualRow.index];
                if (!block) return null;
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    className="w-full"
                  >
                    <MessageBlockRow
                      block={block}
                      blockIndex={virtualRow.index}
                      totalBlocks={messageBlocks.length}
                      isNestedVariant={isNestedVariant}
                      shouldUseContentVisibility={shouldUseContentVisibility}
                      expandedStepIds={expandedStepIds}
                      onExpandedStepIdsChange={onExpandedStepIdsChange}
                      searchMatchMessageIds={props.searchMatchMessageIds}
                      activeSearchMessageId={props.activeSearchMessageId}
                      searchHighlightQuery={props.searchHighlightQuery}
                      isStreaming={props.isStreaming}
                      latestAssistantMessageId={latestAssistantMessageId}
                      onRevertToMessage={props.onRevertToMessage}
                      onForkAtMessage={props.onForkAtMessage}
                      openTargets={props.openTargets}
                      onOpenTarget={props.onOpenTarget}
                    />
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : (
        <div>
          {messageBlocks.map((block, index) => (
            <MessageBlockRow
              key={blockIdentityKey(block)}
              block={block}
              blockIndex={index}
              totalBlocks={messageBlocks.length}
              isNestedVariant={isNestedVariant}
              shouldUseContentVisibility={shouldUseContentVisibility}
              expandedStepIds={expandedStepIds}
              onExpandedStepIdsChange={onExpandedStepIdsChange}
              searchMatchMessageIds={props.searchMatchMessageIds}
              activeSearchMessageId={props.activeSearchMessageId}
              searchHighlightQuery={props.searchHighlightQuery}
              isStreaming={props.isStreaming}
              latestAssistantMessageId={latestAssistantMessageId}
              onRevertToMessage={props.onRevertToMessage}
              onForkAtMessage={props.onForkAtMessage}
              openTargets={props.openTargets}
              onOpenTarget={props.onOpenTarget}
            />
          ))}
        </div>
      )}

      {!isNestedVariant && props.footer ? props.footer : null}
    </div>
  );
}

/**
 * Memoize at the transcript boundary so SessionSurface state churn (e.g.
 * sending=true flipping while the assistant streams) doesn't force a full
 * transcript re-render on every parent commit. Re-renders now happen only
 * when the transcript's own props actually change (messages array
 * identity, isStreaming, developerMode, etc.).
 */
export const SessionTranscript = memo(SessionTranscriptInner);
SessionTranscript.displayName = "SessionTranscript";
