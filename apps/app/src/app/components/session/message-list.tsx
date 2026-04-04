import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import type { JSX } from "solid-js";
import type { Part, Session } from "@opencode-ai/sdk/v2/client";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  File,
} from "lucide-solid";
import { createVirtualizer } from "@tanstack/solid-virtual";

import {
  SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX,
  type MessageGroup,
  type MessageWithParts,
  type StepGroupMode,
} from "../../types";
import {
  groupMessageParts,
  isUserVisiblePart,
  summarizeStep,
} from "../../utils";
import PartView from "../part-view";
import { perfNow, recordPerfLog } from "../../lib/perf-log";

export type MessageListProps = {
  messages: MessageWithParts[];
  isStreaming?: boolean;
  developerMode: boolean;
  showThinking: boolean;
  getSessionById?: (sessionId: string | null) => Session | null;
  getMessagesBySessionId?: (sessionId: string | null) => MessageWithParts[];
  ensureSessionLoaded?: (sessionId: string) => Promise<void> | void;
  sessionLoadingById?: (sessionId: string | null) => boolean;
  expandedStepIds: Set<string>;
  setExpandedStepIds: (updater: (current: Set<string>) => Set<string>) => void;
  openSessionById?: (sessionId: string) => void;
  searchMatchMessageIds?: ReadonlySet<string>;
  activeSearchMessageId?: string | null;
  searchHighlightQuery?: string;
  workspaceRoot?: string;
  scrollElement?: () => HTMLElement | undefined;
  setScrollToMessageById?: (
    handler: ((messageId: string, behavior?: ScrollBehavior) => boolean) | null,
  ) => void;
  footer?: JSX.Element;
  variant?: "default" | "nested";
};

type StepClusterBlock = {
  kind: "steps-cluster";
  id: string;
  stepGroups: StepTimelineGroup[];
  messageIds: string[];
  isUser: boolean;
};

type StepTimelineGroup = {
  id: string;
  parts: Part[];
  mode: StepGroupMode;
};

type MessageBlock = {
  kind: "message";
  message: MessageWithParts;
  renderableParts: Part[];
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

const VIRTUALIZATION_THRESHOLD = 500;
const VIRTUAL_OVERSCAN = 4;

function normalizePath(path: string) {
  const normalized = path.replace(/\\/g, "/").trim().replace(/\/+/g, "/");
  if (!normalized || normalized === "/") return normalized;
  return normalized.replace(/\/+$/, "");
}


type TaskStepInfo = {
  isTask: boolean;
  agentType?: string;
  sessionId?: string;
  description?: string;
};

function formatAgentType(agentType: string): string {
  const clean = agentType.trim().replace(/[_-]+/g, " ");
  if (!clean) return "";
  return clean
    .split(/\s+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function getTaskStepInfo(part: Part): TaskStepInfo {
  if (part.type !== "tool") return { isTask: false };

  const record = part as any;
  const tool = typeof record.tool === "string" ? record.tool.toLowerCase() : "";
  if (tool !== "task") return { isTask: false };

  const state = record.state ?? {};
  const input =
    state.input && typeof state.input === "object"
      ? (state.input as Record<string, unknown>)
      : {};
  const metadata =
    state.metadata && typeof state.metadata === "object"
      ? (state.metadata as Record<string, unknown>)
      : {};

  const rawAgentType =
    typeof input.subagent_type === "string" ? input.subagent_type.trim() : "";
  const agentType = rawAgentType ? formatAgentType(rawAgentType) : undefined;
  const rawSessionId =
    metadata.sessionId ??
    metadata.sessionID ??
    state.sessionId ??
    state.sessionID;
  const rawDescription =
    typeof input.description === "string" && input.description.trim()
      ? input.description.trim()
      : undefined;
  const sessionId =
    typeof rawSessionId === "string" && rawSessionId.trim()
      ? rawSessionId.trim()
      : undefined;

  return { isTask: true, agentType, sessionId, description: rawDescription };
}

function compactPathToken(value: string) {
  const token = value.trim().replace(/^[`'"([{]+|[`'"\])},.;:]+$/g, "");
  const segments = token.split(/[\\/]/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : token;
}

function compactText(value: string, max = 42) {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (!singleLine) return "";
  return singleLine.length > max
    ? `${singleLine.slice(0, Math.max(0, max - 3))}...`
    : singleLine;
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
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function isPathLike(value: string) {
  return (
    /^(?:[A-Za-z]:[\\/]|~[\\/]|\/[\w_\-~]|\.\.?[\\/])/.test(value) ||
    /[\\/](?:\.opencode|Users|Library|workspaces)[\\/]/.test(value)
  );
}

function toolHeadline(part: Part) {
  if (part.type !== "tool") return "";

  const record = part as any;
  const state = record.state ?? {};
  const input =
    state.input && typeof state.input === "object"
      ? (state.input as Record<string, unknown>)
      : {};
  const tool = typeof record.tool === "string" ? record.tool.toLowerCase() : "";

  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };

  const target = (...keys: string[]) => {
    const raw = pick(...keys);
    if (!raw) return "";
    return isPathLike(raw) ? compactPathToken(raw) : raw;
  };

  if (tool === "bash") {
    const description = pick("description");
    if (description) return compactText(description);
    const command = pick("command", "cmd");
    return command ? compactText(`Run ${command}`, 48) : "Run command";
  }

  if (tool === "read") {
    const file = target("filePath", "path", "file");
    return file ? `Reviewed ${file}` : "Reviewed file";
  }

  if (tool === "edit") {
    const file = target("filePath", "path", "file");
    return file ? `Updated ${file}` : "Updated file";
  }

  if (tool === "write" || tool === "apply_patch") {
    const file = target("filePath", "path", "file");
    return file ? `Update ${file}` : "Update file";
  }

  if (tool === "grep" || tool === "glob" || tool === "search") {
    const pattern = pick("pattern", "query");
    return pattern ? `Searched ${compactText(pattern, 36)}` : "Searched code";
  }

  if (tool === "list" || tool === "list_files") {
    const path = target("path");
    return path ? `Reviewed ${path}` : "Reviewed files";
  }

  if (tool === "task") {
    const description = pick("description");
    if (description) return compactText(description);
    const agent = pick("subagent_type");
    return agent ? `Delegate ${agent}` : "Delegate task";
  }

  if (tool === "todowrite") {
    return "Update todo list";
  }

  if (tool === "todoread") {
    return "Read todo list";
  }

  if (tool === "webfetch") {
    const url = pick("url");
    return url ? `Checked ${compactText(url, 36)}` : "Checked web page";
  }

  if (tool === "skill") {
    const name = pick("name");
    return name ? `Load skill ${name}` : "Load skill";
  }

  const fallback = tool
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return fallback ? compactText(fallback, 40) : "";
}

export default function MessageList(props: MessageListProps) {
  const [copyingId, setCopyingId] = createSignal<string | null>(null);
  let previousMessagePartCountById = new Map<string, number>();
  let previousMessageBlockById = new Map<string, MessageBlock>();
  let previousBlockRenderKey = "";
  let copyTimeout: number | undefined;
  const isNestedVariant = () => props.variant === "nested";
  const isAttachmentPart = (part: Part) => {
    if (part.type !== "file") return false;
    const url = (part as { url?: string }).url;
    return typeof url === "string" && !url.startsWith("file://");
  };
  const attachmentsForParts = (parts: Part[]) =>
    parts
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
      .filter((attachment) => !!attachment.url);
  const isImageAttachment = (mime: string) => mime.startsWith("image/");
  onCleanup(() => {
    if (copyTimeout !== undefined) {
      window.clearTimeout(copyTimeout);
    }
  });

  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyingId(id);
      if (copyTimeout !== undefined) {
        window.clearTimeout(copyTimeout);
      }
      copyTimeout = window.setTimeout(() => {
        setCopyingId(null);
        copyTimeout = undefined;
      }, 2000);
    } catch {
      // ignore
    }
  };

  const partToText = (part: Part) => {
    if (part.type === "text") {
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
      };
      const label = record.label ?? record.path ?? record.filename ?? "";
      return label ? `@${label}` : "@file";
    }
    return "";
  };

  const toggleSteps = (id: string, relatedIds: string[] = []) => {
    props.setExpandedStepIds((current) => {
      const next = new Set(current);
      const isExpanded =
        next.has(id) || relatedIds.some((relatedId) => next.has(relatedId));
      if (isExpanded) {
        next.delete(id);
        relatedIds.forEach((relatedId) => next.delete(relatedId));
      } else {
        next.add(id);
        relatedIds.forEach((relatedId) => next.add(relatedId));
      }
      return next;
    });
  };

  const isStepsExpanded = (id: string, relatedIds: string[] = []) =>
    props.expandedStepIds.has(id) ||
    relatedIds.some((relatedId) => props.expandedStepIds.has(relatedId));

  const renderablePartsForMessage = (message: MessageWithParts) =>
    message.parts.filter((part) => {
      if (!props.developerMode && !isUserVisiblePart(part)) {
        return false;
      }

      if (part.type === "reasoning") {
        return props.showThinking;
      }

      if (part.type === "step-start" || part.type === "step-finish") {
        return false;
      }

      if (
        part.type === "text" ||
        part.type === "tool" ||
        part.type === "agent" ||
        part.type === "file"
      ) {
        return true;
      }

      return props.developerMode;
    });

  const messageBlocks = createMemo<MessageBlockItem[]>(() => {
    const startedAt = perfNow();
    const renderKey = `${props.developerMode ? 1 : 0}:${props.showThinking ? 1 : 0}`;
    const blocks: MessageBlockItem[] = [];
    const nextMessagePartCountById = new Map<string, number>();
    const nextMessageBlockById = new Map<string, MessageBlock>();
    let changedMessageCount = 0;
    let addedMessageCount = 0;
    let toolPartCount = 0;
    let stepGroupCount = 0;

    props.messages.forEach((message, index) => {
      const renderableParts = renderablePartsForMessage(message);
      if (!renderableParts.length) return;

      const messageId = String((message.info as any).id ?? "");
      const idKey = messageId || `idx:${index}`;
      const totalParts = message.parts.length;
      nextMessagePartCountById.set(idKey, totalParts);
      const previousPartCount = previousMessagePartCountById.get(idKey);
      const previousBlock = previousMessageBlockById.get(idKey);
      if (previousPartCount === undefined) {
        addedMessageCount += 1;
      } else if (previousPartCount !== totalParts) {
        changedMessageCount += 1;
      }

      const isUser = (message.info as any).role === "user";
      const canReuseStableBlock =
        previousBlockRenderKey === renderKey &&
        index < props.messages.length - 1 &&
        previousPartCount !== undefined &&
        previousPartCount === totalParts &&
        previousBlock?.kind === "message" &&
        previousBlock.isUser === isUser;

      if (canReuseStableBlock && previousBlock) {
        toolPartCount += previousBlock.renderableParts.reduce(
          (count, part) => (part.type === "tool" ? count + 1 : count),
          0,
        );
        stepGroupCount += previousBlock.groups.reduce(
          (count, group) => (group.kind === "steps" ? count + 1 : count),
          0,
        );
        blocks.push(previousBlock);
        nextMessageBlockById.set(idKey, previousBlock);
        return;
      }

      toolPartCount += renderableParts.reduce(
        (count, part) => (part.type === "tool" ? count + 1 : count),
        0,
      );
      const groupId = String((message.info as any).id ?? "message");
      const attachments = attachmentsForParts(renderableParts);
      const nonAttachmentParts = renderableParts.filter((part) => !isAttachmentPart(part));
      const groups = groupMessageParts(nonAttachmentParts, groupId);
      const isStepsOnly =
        groups.length > 0 && groups.every((group) => group.kind === "steps");
      const stepGroups = isStepsOnly
        ? (groups as {
            kind: "steps";
            id: string;
            parts: Part[];
            segment: "execution";
            mode: StepGroupMode;
          }[])
        : [];
      stepGroupCount += groups.reduce(
        (count, group) => (group.kind === "steps" ? count + 1 : count),
        0,
      );

      if (isStepsOnly) {
        blocks.push({
          kind: "steps-cluster",
          id: stepGroups[0].id,
          stepGroups: stepGroups.map((group) => ({
            id: group.id,
            parts: group.parts,
            mode: group.mode,
          })),
          messageIds: [messageId],
          isUser,
        });
        return;
      }

      const block: MessageBlock = {
        kind: "message",
        message,
        renderableParts,
        attachments,
        groups,
        isUser,
        messageId,
      };
      blocks.push(block);
      nextMessageBlockById.set(idKey, block);
    });

    let removedMessageCount = 0;
    previousMessagePartCountById.forEach((_partCount, id) => {
      if (!nextMessagePartCountById.has(id)) {
        removedMessageCount += 1;
      }
    });
    previousMessagePartCountById = nextMessagePartCountById;
    previousMessageBlockById = nextMessageBlockById;
    previousBlockRenderKey = renderKey;

    const elapsedMs = Math.round((perfNow() - startedAt) * 100) / 100;
    if (
      props.developerMode &&
      (elapsedMs >= 6 ||
        (Boolean(props.isStreaming) &&
          props.messages.length >= 16 &&
          changedMessageCount <= 2 &&
          addedMessageCount <= 1 &&
          removedMessageCount === 0) ||
        (Boolean(props.isStreaming) && toolPartCount >= 10))
    ) {
      recordPerfLog(true, "session.render", "message-blocks", {
        messageCount: props.messages.length,
        blockCount: blocks.length,
        changedMessageCount,
        addedMessageCount,
        removedMessageCount,
        toolPartCount,
        stepGroupCount,
        streaming: Boolean(props.isStreaming),
        ms: elapsedMs,
      });
    }

    return blocks;
  });

  const latestAssistantMessageId = createMemo(() => {
    for (let index = props.messages.length - 1; index >= 0; index -= 1) {
      const message = props.messages[index];
      if ((message.info as any).role === "assistant") {
        return String((message.info as any).id ?? "");
      }
    }
    return "";
  });

  const blockIndexByMessageId = createMemo(() => {
    const next = new Map<string, number>();
    messageBlocks().forEach((block, index) => {
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
  });

  const shouldVirtualize = createMemo(
    () =>
      Boolean(props.scrollElement?.()) &&
      messageBlocks().length >= VIRTUALIZATION_THRESHOLD,
  );

  const virtualizer = createVirtualizer<HTMLElement, HTMLDivElement>({
    get count() {
      return messageBlocks().length;
    },
    getScrollElement: () => props.scrollElement?.() ?? null,
    estimateSize: () => 220,
    overscan: VIRTUAL_OVERSCAN,
    getItemKey: (index) => {
      const block = messageBlocks()[index];
      if (!block) return `block-${index}`;
      if (block.kind === "steps-cluster") {
        return `steps-${block.messageIds.join(",")}`;
      }
      return `message-${block.messageId}`;
    },
  });

  let cachedVirtualRows: ReturnType<typeof virtualizer.getVirtualItems> = [];
  const virtualRows = createMemo(() => {
    if (!shouldVirtualize()) {
      cachedVirtualRows = [];
      return [];
    }
    const rows = virtualizer.getVirtualItems();
    if (rows.length > 0) {
      cachedVirtualRows = rows;
      return rows;
    }
    return cachedVirtualRows;
  });

  const virtualRowByIndex = createMemo(() => {
    const map = new Map<
      number,
      ReturnType<typeof virtualizer.getVirtualItems>[number]
    >();
    virtualRows().forEach((row) => {
      map.set(row.index, row);
    });
    return map;
  });

  const virtualRowIndices = createMemo(() =>
    virtualRows().map((row) => row.index),
  );

  const shouldUseContentVisibility = createMemo(
    () => !shouldVirtualize() && messageBlocks().length > 500,
  );
  const blockPerfStyle = (index: number): JSX.CSSProperties | undefined => {
    if (!shouldUseContentVisibility()) return undefined;
    const total = messageBlocks().length;
    if (index >= total - 24) return undefined;
    return {
      "content-visibility": "auto",
      "contain-intrinsic-size": "220px",
    };
  };

  createEffect(() => {
    const setScrollToMessageById = props.setScrollToMessageById;
    if (!setScrollToMessageById) return;
    const indexById = blockIndexByMessageId();
    const useVirtualization = shouldVirtualize();

    setScrollToMessageById((messageId, behavior = "smooth") => {
      const index = indexById.get(messageId);
      if (index === undefined) return false;

      if (useVirtualization) {
        virtualizer.scrollToIndex(index, { align: "center" });
        return true;
      }

      const container = props.scrollElement?.();
      if (!container) return false;
      const escapedId = messageId.replace(/"/g, '\\"');
      const target = container.querySelector(
        `[data-message-id="${escapedId}"]`,
      ) as HTMLElement | null;
      if (!target) return false;
      target.scrollIntoView({ behavior, block: "center" });
      return true;
    });
  });

  createEffect(() => {
    if (!shouldVirtualize()) return;
    queueMicrotask(() => {
      virtualizer.measure();
    });
  });

  onCleanup(() => {
    props.setScrollToMessageById?.(null);
  });

  const sessionStreamState = (messages: MessageWithParts[]) => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const info = messages[index]?.info as { role?: string; time?: { completed?: number } };
      if (info?.role !== "assistant") continue;
      return !info.time?.completed;
    }
    return false;
  };

  const SubagentThread = (threadProps: { part: Part }) => {
    const task = createMemo(() => getTaskStepInfo(threadProps.part));
    const sessionId = createMemo(() => task().sessionId ?? null);
    const [open, setOpen] = createSignal(true);
    let requestedSessionId = "";
    const session = createMemo(() => props.getSessionById?.(sessionId()) ?? null);
    const childMessages = createMemo(() => props.getMessagesBySessionId?.(sessionId()) ?? []);
    const loading = createMemo(() => props.sessionLoadingById?.(sessionId()) ?? false);
    const streaming = createMemo(() => loading() || sessionStreamState(childMessages()));
    const label = createMemo(() => {
      const title = session()?.title?.trim();
      if (title) return title;
      if (task().description) return task().description!;
      if (task().agentType) return `${task().agentType} task`;
      return "Subagent session";
    });
    const statusLabel = createMemo(() => {
      if (loading()) return "Loading transcript";
      if (streaming()) return "Running";
      if (childMessages().length > 0) {
        const count = childMessages().length;
        return `${count} message${count === 1 ? "" : "s"}`;
      }
      return "Waiting for transcript";
    });

    createEffect(() => {
      const id = sessionId();
      if (!id) return;
      if (!props.ensureSessionLoaded) return;
      if (requestedSessionId === id) return;
      requestedSessionId = id;
      void props.ensureSessionLoaded(id);
    });

    return (
      <Show when={sessionId()}>
        <div class="mt-3 border-l border-dls-border/70 pl-4">
          <div class="flex flex-wrap items-center gap-2 text-[12px] text-gray-10">
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-full border border-dls-border bg-dls-surface px-2.5 py-1 text-[12px] font-medium text-dls-text transition-colors hover:bg-dls-hover"
              onClick={() => setOpen((value) => !value)}
            >
              <Show when={open()} fallback={<ChevronRight size={12} />}>
                <ChevronDown size={12} />
              </Show>
              <span>{label()}</span>
            </button>
            <span class="text-gray-9">{statusLabel()}</span>
            <Show when={task().agentType && task().agentType !== label()}>
              <span class="text-gray-8">{task().agentType}</span>
            </Show>
            <Show when={props.openSessionById && sessionId()}>
              <button
                type="button"
                class="text-dls-link transition-colors hover:text-dls-text"
                onClick={() => {
                  const id = sessionId();
                  if (!id) return;
                  props.openSessionById?.(id);
                }}
              >
                Open session
              </button>
            </Show>
          </div>
          <Show when={open()}>
            <div class="mt-3 rounded-[18px] border border-dls-border/70 bg-dls-surface px-3 py-3">
              <Show
                when={childMessages().length > 0}
                fallback={<div class="text-[12px] leading-5 text-gray-9">Waiting for the subagent transcript to arrive.</div>}
              >
                <MessageList
                  messages={childMessages()}
                  isStreaming={streaming()}
                  developerMode={props.developerMode}
                  showThinking={props.showThinking}
                  getSessionById={props.getSessionById}
                  getMessagesBySessionId={props.getMessagesBySessionId}
                  ensureSessionLoaded={props.ensureSessionLoaded}
                  sessionLoadingById={props.sessionLoadingById}
                  expandedStepIds={props.expandedStepIds}
                  setExpandedStepIds={props.setExpandedStepIds}
                  openSessionById={props.openSessionById}
                  workspaceRoot={props.workspaceRoot}
                  variant="nested"
                />
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    );
  };

  /** Transcript step row */
  const StepRow = (rowProps: {
    id: string;
    part: Part;
    isUser: boolean;
    groupMode?: StepGroupMode;
  }) => {
    const summary = createMemo(() => summarizeStep(rowProps.part));
    const task = createMemo(() => getTaskStepInfo(rowProps.part));
    const toolState = createMemo(() => {
      if (rowProps.part.type !== "tool") return {} as Record<string, unknown>;
      return (((rowProps.part as any).state ?? {}) as Record<string, unknown>);
    });
    const toolInput = createMemo(() => {
      const input = toolState().input;
      return input && typeof input === "object"
        ? (input as Record<string, unknown>)
        : undefined;
    });
    const toolOutput = createMemo(() => toolState().output);
    const expandable = createMemo(
      () =>
        rowProps.part.type === "tool" &&
        (hasStructuredValue(toolInput()) ||
          hasStructuredValue(toolOutput()) ||
          Boolean(task().isTask && task().sessionId)),
    );
    const expanded = createMemo(
      () => expandable() && isStepsExpanded(rowProps.id),
    );
    const headline = createMemo(() => {
      const title = summary().title?.trim() ?? "";
      if (title) return title;
      const fromTool = toolHeadline(rowProps.part);
      return fromTool || "Updates progress";
    });
    const reasoningText = createMemo(() => {
      if (rowProps.part.type !== "reasoning") return "";
      const raw = typeof (rowProps.part as any).text === "string" ? (rowProps.part as any).text : "";
      return cleanReasoningPreview(raw);
    });

    if (rowProps.part.type === "reasoning") {
      return (
        <div class="text-[14px] leading-[1.7] text-gray-9 whitespace-pre-wrap">
          <div class="max-w-[720px]">{reasoningText() || headline()}</div>
        </div>
      );
    }

    return (
      <div class="text-[14px] text-gray-9">
        <button
          type="button"
          class="w-full text-left transition-colors hover:text-dls-text disabled:cursor-default"
          aria-expanded={expandable() ? expanded() : undefined}
          disabled={!expandable()}
          onClick={() => {
            if (!expandable()) return;
            toggleSteps(rowProps.id);
          }}
        >
          <span class="inline-flex max-w-[720px] items-start gap-1.5 leading-relaxed align-top">
            <span class="min-w-0 break-words">{headline()}</span>
            <Show when={expandable()}>
              <ChevronDown
                size={14}
                class={`mt-[2px] shrink-0 text-gray-8 transition-transform ${expanded() ? "" : "-rotate-90"}`}
              />
            </Show>
          </span>
        </button>
        <Show when={expanded()}>
          <div class="mt-3 ml-[22px] space-y-3">
            <Show when={hasStructuredValue(toolInput())}>
              <div>
                <div class="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-8">Request</div>
                <pre class="overflow-x-auto rounded-[16px] border border-dls-border/70 bg-dls-surface px-4 py-3 text-[12px] leading-6 text-gray-10">{formatStructuredValue(toolInput())}</pre>
              </div>
            </Show>
            <Show when={hasStructuredValue(toolOutput())}>
              <div>
                <div class="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-8">Result</div>
                <pre class="overflow-x-auto rounded-[16px] border border-dls-border/70 bg-dls-surface px-4 py-3 text-[12px] leading-6 text-gray-10">{formatStructuredValue(toolOutput())}</pre>
              </div>
            </Show>
            <Show when={task().isTask && task().sessionId}>
              <SubagentThread part={rowProps.part} />
            </Show>
          </div>
        </Show>
      </div>
    );
  };

  /** Quiet steps list */
  const StepsList = (listProps: {
    groupId: string;
    parts: Part[];
    isUser: boolean;
    groupMode: StepGroupMode;
  }) => (
    <div class="flex flex-col gap-4">
      <For each={listProps.parts}>
        {(part, index) => (
          <StepRow
            id={`${listProps.groupId}:${index()}`}
            part={part}
            isUser={listProps.isUser}
            groupMode={listProps.groupMode}
          />
        )}
      </For>
    </div>
  );

  /** Expandable steps container */
  const StepsContainer = (containerProps: {
    id: string;
    relatedIds?: string[];
    stepGroups: StepTimelineGroup[];
    isUser: boolean;
    isInline?: boolean;
  }) => {
    const useInnerTimelineScroll = () => !Boolean(props.isStreaming);
    return (
      <div
        class={
          containerProps.isInline
            ? containerProps.isUser
              ? "mt-3"
              : "mt-4"
            : ""
        }
      >
        <div>
          <div
            class={`${!isNestedVariant() && useInnerTimelineScroll() ? "max-h-[420px] overflow-y-auto pr-3" : ""}`}
          >
            <div class="flex flex-col gap-4">
              <For each={containerProps.stepGroups}>
                {(group) => (
                  <StepsList
                    groupId={group.id}
                    parts={group.parts}
                    isUser={containerProps.isUser}
                    groupMode={group.mode}
                  />
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderBlock = (block: MessageBlockItem, blockIndex: number) => {
    const blockMessageIds =
      block.kind === "steps-cluster" ? block.messageIds : [block.messageId];
    const hasSearchMatch = blockMessageIds.some((id) =>
      props.searchMatchMessageIds?.has(id),
    );
    const hasActiveSearchMatch = blockMessageIds.some(
      (id) => id === props.activeSearchMessageId,
    );
    const searchOutlineClass = hasActiveSearchMatch
      ? "outline outline-2 outline-amber-8/70 outline-offset-2 rounded-2xl"
      : hasSearchMatch
        ? "outline outline-1 outline-amber-7/50 outline-offset-1 rounded-2xl"
        : "";

    if (block.kind === "steps-cluster") {
      return (
        <div
          class={`flex group ${block.isUser ? "justify-end" : "justify-start"}`.trim()}
          data-message-role={block.isUser ? "user" : "assistant"}
          data-message-id={block.messageIds[0] ?? ""}
          style={blockPerfStyle(blockIndex)}
        >
          <div
            class={`${
              block.isUser
                ? isNestedVariant()
                  ? "relative max-w-[92%] rounded-[20px] border border-dls-border bg-dls-sidebar px-4 py-3 text-[14px] leading-relaxed text-dls-text"
                  : "relative max-w-[85%] rounded-[24px] border border-dls-border bg-dls-sidebar px-6 py-4 text-[15px] leading-relaxed text-dls-text"
                : isNestedVariant()
                  ? "w-full relative text-[14px] leading-[1.65] text-dls-text group"
                  : "w-full relative max-w-[760px] text-[15px] leading-[1.7] text-dls-text group"
            } ${searchOutlineClass}`}
          >
            <StepsContainer
              id={block.id}
              relatedIds={block.stepGroups
                .map((stepGroup) => stepGroup.id)
                .filter((stepId) => stepId !== block.id)}
              stepGroups={block.stepGroups}
              isUser={block.isUser}
            />
          </div>
        </div>
      );
    }

    const groupSpacing = block.isUser ? "mb-3" : "mb-4";
    const isSyntheticSessionError =
      !block.isUser &&
      block.messageId.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX);

    if (isSyntheticSessionError) {
      const messageText = block.renderableParts
        .map((part) => partToText(part))
        .join(" ")
        .replace(/\s*\n+\s*/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();

      return (
        <div
          class="flex group justify-start"
          data-message-role="assistant"
          data-message-id={block.messageId}
          style={blockPerfStyle(blockIndex)}
        >
          <div class={`w-full relative ${isNestedVariant() ? "" : "max-w-[650px]"} ${searchOutlineClass}`}>
            <div
              class="inline-flex max-w-full items-start gap-2 rounded-[18px] border border-red-7/20 bg-red-1/35 px-3 py-2 text-[13px] leading-5 text-red-12 shadow-sm"
              role="alert"
            >
              <CircleAlert size={14} class="mt-0.5 shrink-0" />
              <div class="min-w-0 break-words">{messageText}</div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div
        class={`flex group ${block.isUser ? "justify-end" : "justify-start"}`.trim()}
        data-message-role={block.isUser ? "user" : "assistant"}
        data-message-id={block.messageId}
        style={blockPerfStyle(blockIndex)}
      >
        <div
          class={`${
            block.isUser
              ? isNestedVariant()
                ? "relative max-w-[92%] rounded-[20px] border border-dls-border bg-dls-sidebar px-4 py-3 text-[14px] leading-relaxed text-dls-text"
                : "relative max-w-[85%] rounded-[24px] border border-dls-border bg-dls-sidebar px-6 py-4 text-[15px] leading-relaxed text-dls-text"
              : isNestedVariant()
                ? "w-full relative text-[14px] leading-[1.65] text-dls-text antialiased group"
                : "w-full relative max-w-[760px] text-[15px] leading-[1.72] text-dls-text antialiased group"
          } ${searchOutlineClass}`}
        >
          <Show when={block.attachments.length > 0}>
            <div
              class={
                block.isUser
                  ? "mb-3 flex flex-wrap gap-2"
                  : "mb-4 flex flex-wrap gap-2"
              }
            >
              <For each={block.attachments}>
                {(attachment) => (
                  <div class="flex items-center gap-2 rounded-[18px] border border-dls-border bg-dls-surface px-3 py-2 text-xs text-gray-11 shadow-[var(--dls-card-shadow)]">
                    <Show
                      when={isImageAttachment(attachment.mime)}
                      fallback={<File size={14} class="text-gray-9" />}
                    >
                      <div class="h-12 w-12 overflow-hidden rounded-xl border border-dls-border bg-dls-sidebar">
                        <img
                          src={attachment.url}
                          alt={attachment.filename}
                          loading="lazy"
                          decoding="async"
                          class="h-full w-full object-cover"
                        />
                      </div>
                    </Show>
                    <div class="max-w-[180px]">
                      <div class="truncate text-gray-12">
                        {attachment.filename}
                      </div>
                      <div class="text-[10px] text-gray-9">
                        {attachment.mime}
                      </div>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <For each={block.groups}>
            {(group, idx) => (
              <div
                class={idx() === block.groups.length - 1 ? "" : groupSpacing}
              >
                <Show when={group.kind === "text"}>
                  {(() => {
                    const isStreamingLatestAssistant =
                      !block.isUser &&
                      props.isStreaming &&
                      block.messageId === latestAssistantMessageId();
                    const markdownThrottleMs = isStreamingLatestAssistant
                      ? 120
                      : 100;
                    return (
                      <PartView
                        part={
                          (
                            group as {
                              kind: "text";
                              part: Part;
                              segment: "intent" | "result";
                            }
                          ).part
                        }
                        developerMode={props.developerMode}
                        showThinking={props.showThinking}
                        workspaceRoot={props.workspaceRoot}
                        tone={block.isUser ? "dark" : "light"}
                        renderMarkdown={!block.isUser}
                        markdownThrottleMs={markdownThrottleMs}
                        highlightQuery={
                          hasSearchMatch
                            ? props.searchHighlightQuery
                            : undefined
                        }
                      />
                    );
                  })()}
                </Show>
                {group.kind === "steps" &&
                  (() => {
                    const stepGroup = group as {
                      kind: "steps";
                      id: string;
                      parts: Part[];
                      segment: "execution";
                      mode: StepGroupMode;
                    };
                    return (
                      <StepsContainer
                        id={stepGroup.id}
                        stepGroups={[
                          {
                            id: stepGroup.id,
                            parts: stepGroup.parts,
                            mode: stepGroup.mode,
                          },
                        ]}
                        isUser={block.isUser}
                        isInline={true}
                      />
                    );
                  })()}
              </div>
            )}
          </For>
          <Show when={!isNestedVariant()}>
            <div class="absolute bottom-2 right-2 flex justify-end opacity-100 pointer-events-auto md:opacity-0 md:pointer-events-none md:group-hover:opacity-100 md:group-hover:pointer-events-auto md:group-focus-within:opacity-100 md:group-focus-within:pointer-events-auto transition-opacity select-none">
              <button
                class="text-dls-secondary hover:text-dls-text p-1 rounded hover:bg-dls-hover transition-colors"
                title="Copy message"
                onClick={() => {
                  const text = block.renderableParts
                    .map((part) => partToText(part))
                    .join("\n");
                  handleCopy(text, block.messageId);
                }}
              >
                <Show
                  when={copyingId() === block.messageId}
                  fallback={<Copy size={12} />}
                >
                  <Check size={12} class="text-green-10" />
                </Show>
              </button>
            </div>
          </Show>
        </div>
      </div>
    );
  };

  return (
    <div class={isNestedVariant() ? "pb-0" : "pb-10"} style={{ contain: "layout paint style" }}>
      <Show
        when={shouldVirtualize()}
        fallback={
          <div class={isNestedVariant() ? "space-y-3" : "space-y-4"}>
            <For each={messageBlocks()}>
              {(block, blockIndex) => renderBlock(block, blockIndex())}
            </For>
          </div>
        }
      >
        <Show
          when={virtualRows().length > 0}
          fallback={
            <div class={isNestedVariant() ? "space-y-3" : "space-y-4"}>
              <For each={messageBlocks()}>
                {(block, blockIndex) => renderBlock(block, blockIndex())}
              </For>
            </div>
          }
        >
          <div
            class="relative"
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
            }}
          >
            <For each={virtualRowIndices()}>
              {(rowIndex) => {
                const virtualRow = virtualRowByIndex().get(rowIndex);
                if (!virtualRow) return null;
                const block = messageBlocks()[rowIndex];
                if (!block) return null;
                return (
                  <div
                    data-index={rowIndex}
                    ref={(el) => virtualizer.measureElement(el)}
                    class="absolute left-0 top-0 w-full pb-4"
                    style={{
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {renderBlock(block, rowIndex)}
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>
      <Show when={!isNestedVariant() && props.footer}>{props.footer}</Show>
    </div>
  );
}
