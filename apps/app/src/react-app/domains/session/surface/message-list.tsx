/** @jsxImportSource react */
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { isToolUIPart, type DynamicToolUIPart, type UIMessage } from "ai";
import type { Part } from "@opencode-ai/sdk/v2/client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ChevronDown, CircleAlert, Copy, File as FileIcon } from "lucide-react";

import {
  SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX,
  type MessageGroup,
  type StepGroupMode,
} from "../../../../app/types";
import { groupMessageParts, summarizeStep } from "../../../../app/utils";
import { MarkdownBlock } from "./markdown";
import { applyTextHighlights } from "./text-highlights";

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
  return parts
    .filter(isAttachmentPart)
    .map((part) => {
      const record = part as {
        url?: string;
        filename?: string;
        mime?: string;
      };
      return {
        url: record.url ?? "",
        filename: record.filename ?? "attachment",
        mime: record.mime ?? "application/octet-stream",
      };
    })
    .filter((attachment) => Boolean(attachment.url));
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
  return value
    .replace(/\[REDACTED\]/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+\n/g, "\n")
    .trim();
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

function isDesktopRuntime() {
  try {
    return Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__);
  } catch {
    return false;
  }
}

async function openFileWithOS(path: string) {
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(path);
  } catch {
    // silently fail on web
  }
}

async function revealFileInFinder(path: string) {
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  } catch {
    // silently fail on web
  }
}

function CopyButton(props: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="inline-flex items-center justify-center rounded-lg border border-dls-border bg-dls-surface p-1.5 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
      title="Copy message"
      onClick={async () => {
        await navigator.clipboard.writeText(props.text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

function HighlightedPlainText(props: {
  text: string;
  className: string;
  highlightQuery?: string;
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

  return (
    <div ref={rootRef} className={props.className}>
      {props.text}
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
      className={`group relative flex items-center gap-3 rounded-2xl border px-4 py-3 transition-colors ${
        props.tone === "user"
          ? "border-gray-6/60 bg-gray-2/40 hover:bg-gray-2/60"
          : "border-gray-6/40 bg-gray-1/40 hover:bg-gray-2/30"
      }`}
    >
      {isImage && props.part.url ? (
        <div className="h-11 w-11 shrink-0 overflow-hidden rounded-xl border border-dls-border/60 bg-dls-surface">
          <img src={props.part.url} alt={title} loading="lazy" decoding="async" className="h-full w-full object-cover" />
        </div>
      ) : (
        <div
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
            props.tone === "user" ? "bg-gray-3/60 text-gray-11" : "bg-gray-2/60 text-gray-10"
          }`}
        >
          <FileIcon size={20} />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium leading-snug text-gray-12">{title}</div>
        {badge ? (
          <div className="mt-1 inline-flex rounded-md bg-gray-3/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-10">
            {badge}
          </div>
        ) : null}
      </div>

      {isDesktop && hasPath ? (
        <div className="relative">
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-xl text-gray-9 opacity-0 transition-all hover:bg-gray-3/60 hover:text-gray-12 group-hover:opacity-100"
            onClick={() => setMenuOpen((value) => !value)}
            title="File actions"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
          </button>
          {menuOpen ? (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full z-40 mt-1 w-48 rounded-2xl border border-dls-border bg-dls-surface p-1.5 shadow-lg">
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-gray-12 transition-colors hover:bg-gray-3/60"
                  onClick={() => {
                    void openFileWithOS(props.part.url);
                    setMenuOpen(false);
                  }}
                >
                  Open with default app
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-gray-12 transition-colors hover:bg-gray-3/60"
                  onClick={() => {
                    void revealFileInFinder(props.part.url);
                    setMenuOpen(false);
                  }}
                >
                  Reveal in Finder
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-gray-12 transition-colors hover:bg-gray-3/60"
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

  if (props.part.type === "reasoning") {
    const raw = typeof (props.part as { text?: unknown }).text === "string"
      ? (props.part as { text: string }).text
      : "";
    return (
      <div className="text-[14px] leading-[1.7] text-gray-9 whitespace-pre-wrap">
        <div className="max-w-[720px]">{cleanReasoningPreview(raw) || headline}</div>
      </div>
    );
  }

  return (
    <div className="text-[14px] text-gray-9">
      <button
        type="button"
        className="w-full text-left transition-colors hover:text-dls-text disabled:cursor-default"
        aria-expanded={expandable ? props.expanded : undefined}
        disabled={!expandable}
        onClick={() => {
          if (!expandable) return;
          props.onToggle();
        }}
      >
        <span className="inline-flex max-w-[720px] items-start gap-1.5 leading-relaxed align-top">
          <span className="min-w-0 break-words">{headline}</span>
          {expandable ? (
            <ChevronDown
              size={14}
              className={`mt-[2px] shrink-0 text-gray-8 transition-transform ${
                props.expanded ? "" : "-rotate-90"
              }`}
            />
          ) : null}
        </span>
      </button>
      {props.expanded ? (
        <div className="mt-3 ml-[22px] space-y-3">
          {hasStructuredValue(toolInput) ? (
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-8">Request</div>
              <pre className="overflow-x-auto rounded-[16px] border border-dls-border/70 bg-dls-surface px-4 py-3 text-[12px] leading-6 text-gray-10">
                {formatStructuredValue(toolInput)}
              </pre>
            </div>
          ) : null}
          {hasStructuredValue(toolOutput) ? (
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-8">Result</div>
              <pre className="overflow-x-auto rounded-[16px] border border-dls-border/70 bg-dls-surface px-4 py-3 text-[12px] leading-6 text-gray-10">
                {formatStructuredValue(toolOutput)}
              </pre>
            </div>
          ) : null}
          {toolError ? (
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-red-10">Error</div>
              <pre className="overflow-x-auto rounded-[16px] border border-red-6/40 bg-red-3/20 px-4 py-3 text-[12px] leading-6 text-red-11">
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
  isStreaming: boolean;
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

  const useInnerTimelineScroll = !props.isStreaming;

  return (
    <div className={props.isInline ? (props.isUser ? "mt-3" : "mt-4") : ""}>
      <div
        data-scrollable={useInnerTimelineScroll && !props.isNestedVariant ? "true" : undefined}
        className={
          !props.isNestedVariant && useInnerTimelineScroll
            ? "max-h-[420px] overflow-y-auto pr-3"
            : ""
        }
      >
        <div className="flex flex-col gap-4">
          {props.stepGroups.map((group) => (
            <div key={group.id} className="flex flex-col gap-4">
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

function SessionTranscriptInner(props: SessionTranscriptProps) {
  const showThinking = props.showThinking ?? props.developerMode;
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
      parts: message.parts
        .map((part, index) => toLegacyPart(part, `${message.id}:${index}`))
        .filter((part): part is TranscriptPart => Boolean(part)),
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

  const virtualizer = useVirtualizer({
    count: messageBlocks.length,
    getScrollElement: () => props.scrollElement?.() ?? null,
    // Give react-virtual a shape-aware estimate so the initial scroll
    // height is closer to reality. Small steps-cluster rows are much
    // shorter than full assistant message blocks; a good estimate means
    // fewer measurement-driven scroll corrections as rows come into view.
    estimateSize: (index) => {
      const block = messageBlocks[index];
      if (!block) return 180;
      if (block.kind === "steps-cluster") return 80;
      return block.isUser ? 96 : 320;
    },
    overscan: VIRTUAL_OVERSCAN,
    getItemKey: (index) => {
      const block = messageBlocks[index];
      if (!block) return `block-${index}`;
      if (block.kind === "steps-cluster") {
        return `steps-${block.messageIds.join(",")}`;
      }
      return `message-${block.messageId}`;
    },
  });

  const virtualRows = shouldVirtualize ? virtualizer.getVirtualItems() : [];

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

  const blockPerfStyle = (index: number): CSSProperties | undefined => {
    if (!shouldUseContentVisibility) return undefined;
    const total = messageBlocks.length;
      if (index >= total - 12) return undefined;
      return {
        contentVisibility: "auto",
        containIntrinsicSize: "180px",
      };
    };

  const renderBlock = (block: MessageBlockItem, blockIndex: number) => {
    const blockMessageIds = block.kind === "steps-cluster" ? block.messageIds : [block.messageId];
    const hasSearchMatch = blockMessageIds.some((id) => props.searchMatchMessageIds?.has(id));
    const hasActiveSearchMatch = blockMessageIds.some((id) => id === props.activeSearchMessageId);
    const searchOutlineClass = hasActiveSearchMatch
      ? "outline outline-2 outline-amber-8/70 outline-offset-2 rounded-2xl"
      : hasSearchMatch
        ? "outline outline-1 outline-amber-7/50 outline-offset-1 rounded-2xl"
        : "";

    if (block.kind === "steps-cluster") {
      return (
        <div
          key={`steps-${block.id}`}
          className={`flex group ${block.isUser ? "justify-end" : "justify-start"}`.trim()}
          data-message-role={block.isUser ? "user" : "assistant"}
          data-message-id={block.messageIds[0] ?? ""}
          style={{ contain: "layout style paint", ...blockPerfStyle(blockIndex) }}
        >
          <div
            className={`${
              block.isUser
                ? isNestedVariant
                  ? "relative max-w-[92%] rounded-[20px] border border-dls-border bg-dls-sidebar px-4 py-3 text-[14px] leading-relaxed text-dls-text"
                  : "relative max-w-[85%] rounded-[24px] border border-dls-border bg-dls-sidebar px-6 py-4 text-[15px] leading-relaxed text-dls-text"
                : isNestedVariant
                  ? "w-full relative text-[14px] leading-[1.65] text-dls-text group"
                  : "w-full relative max-w-[760px] text-[15px] leading-[1.7] text-dls-text group"
            } ${searchOutlineClass}`}
          >
            <StepsContainer
              stepGroups={block.stepGroups}
              isUser={block.isUser}
              isNestedVariant={isNestedVariant}
              isStreaming={props.isStreaming}
              expandedStepIds={expandedStepIds}
              onExpandedStepIdsChange={onExpandedStepIdsChange}
            />
          </div>
        </div>
      );
    }

    const groupSpacing = block.isUser ? "mb-3" : "mb-4";
    const isSyntheticSessionError =
      !block.isUser && block.messageId.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX);

    if (isSyntheticSessionError) {
      const messageText = block.renderableParts
        .map((part) => partToText(part))
        .join(" ")
        .replace(/\s*\n+\s*/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();

      return (
        <div
          key={`error-${block.messageId}`}
          className="flex group justify-start"
          data-message-role="assistant"
          data-message-id={block.messageId}
          style={{ contain: "layout style paint", ...blockPerfStyle(blockIndex) }}
        >
          <div className={`w-full relative ${isNestedVariant ? "" : "max-w-[650px]"} ${searchOutlineClass}`}>
            <div
              className="inline-flex max-w-full items-start gap-2 rounded-[18px] border border-red-7/20 bg-red-1/35 px-3 py-2 text-[13px] leading-5 text-red-12 shadow-sm"
              role="alert"
            >
              <CircleAlert size={14} className="mt-0.5 shrink-0" />
              <div className="min-w-0 break-words">{messageText}</div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div
        key={`message-${block.messageId}`}
        className={`flex group ${block.isUser ? "justify-end" : "justify-start"}`.trim()}
        data-message-role={block.isUser ? "user" : "assistant"}
        data-message-id={block.messageId}
        style={{ contain: "layout style paint", ...blockPerfStyle(blockIndex) }}
      >
        <div
          className={`${
            block.isUser
              ? isNestedVariant
                ? "relative max-w-[92%] rounded-[20px] border border-dls-border bg-dls-sidebar px-4 py-3 text-[14px] leading-relaxed text-dls-text"
                : "relative max-w-[85%] rounded-[24px] border border-dls-border bg-dls-sidebar px-6 py-4 text-[15px] leading-relaxed text-dls-text"
              : isNestedVariant
                ? "w-full relative text-[14px] leading-[1.65] text-dls-text antialiased group"
                : "w-full relative max-w-[760px] text-[15px] leading-[1.72] text-dls-text antialiased group"
          } ${searchOutlineClass}`}
        >
          {block.attachments.length > 0 ? (
            <div className={block.isUser ? "mb-3 flex flex-wrap gap-2" : "mb-4 flex flex-wrap gap-2"}>
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

          {block.groups.map((group, index) => {
            const highlightQuery = hasSearchMatch ? props.searchHighlightQuery : undefined;
            const isStreamingLatestAssistant =
              !block.isUser && props.isStreaming && block.messageId === latestAssistantMessageId;

            return (
              <div key={`${block.messageId}:${group.kind}:${index}`} className={index === block.groups.length - 1 ? "" : groupSpacing}>
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
                        className="whitespace-pre-wrap break-words text-gray-12"
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
                    isNestedVariant={isNestedVariant}
                    isStreaming={props.isStreaming}
                    expandedStepIds={expandedStepIds}
                    onExpandedStepIdsChange={onExpandedStepIdsChange}
                  />
                ) : null}
              </div>
            );
          })}

          {!isNestedVariant ? (
            <div className="absolute bottom-2 right-2 flex justify-end opacity-100 pointer-events-auto md:opacity-0 md:pointer-events-none md:group-hover:opacity-100 md:group-hover:pointer-events-auto md:group-focus-within:opacity-100 md:group-focus-within:pointer-events-auto transition-opacity select-none">
              <CopyButton text={messageToText(block.message)} />
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className={isNestedVariant ? "pb-0" : "pb-10"} style={{ contain: "layout paint style" }}>
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
          {virtualRows.map((virtualRow) => {
            const block = messageBlocks[virtualRow.index];
            if (!block) return null;
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={(element) => {
                  if (element) {
                    virtualizer.measureElement(element);
                  }
                }}
                className="absolute left-0 top-0 w-full pb-4"
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {renderBlock(block, virtualRow.index)}
              </div>
            );
          })}
        </div>
      ) : (
        <div className={isNestedVariant ? "space-y-3" : "space-y-4"}>
          {messageBlocks.map((block, index) => renderBlock(block, index))}
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
