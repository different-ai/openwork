import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import type { Part } from "@opencode-ai/sdk/v2/client";
import { Check, ChevronDown, ChevronRight, Copy, Eye, File, FileEdit, FolderSearch, Pencil, Search, Sparkles, Terminal } from "lucide-solid";

import type { MessageGroup, MessageWithParts, StepGroupMode } from "../../types";
import { groupMessageParts, isUserVisiblePart, summarizeStep } from "../../utils";
import PartView from "../part-view";
import { perfNow, recordPerfLog } from "../../lib/perf-log";

export type MessageListProps = {
  messages: MessageWithParts[];
  isStreaming?: boolean;
  developerMode: boolean;
  showThinking: boolean;
  expandedStepIds: Set<string>;
  setExpandedStepIds: (updater: (current: Set<string>) => Set<string>) => void;
  openSessionById?: (sessionId: string) => void;
  searchMatchMessageIds?: ReadonlySet<string>;
  activeSearchMessageId?: string | null;
  searchHighlightQuery?: string;
  workspaceRoot?: string;
  footer?: JSX.Element;
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
  groups: MessageGroup[];
  isUser: boolean;
  messageId: string;
};

type MessageBlockItem = MessageBlock | StepClusterBlock;

const EXPLORATION_TOOL_NAMES = new Set(["read", "glob", "grep", "search", "list", "list_files"]);

type ExplorationSummary = {
  files: number;
  searches: number;
  lists: number;
};

function isExplorationTool(part: Part) {
  if (part.type !== "tool") return false;
  const tool = typeof (part as any).tool === "string" ? String((part as any).tool).toLowerCase() : "";
  return EXPLORATION_TOOL_NAMES.has(tool);
}

function normalizePath(path: string) {
  const normalized = path.replace(/\\/g, "/").trim().replace(/\/+/g, "/");
  if (!normalized || normalized === "/") return normalized;
  return normalized.replace(/\/+$/, "");
}

function summarizeExploration(parts: Part[]): ExplorationSummary {
  const files = new Set<string>();
  let fileWithoutPath = 0;
  let searches = 0;
  let lists = 0;

  parts.forEach((part) => {
    if (part.type !== "tool") return;
    const tool = typeof (part as any).tool === "string" ? String((part as any).tool).toLowerCase() : "";
    const state = (part as any).state ?? {};
    const input = state.input && typeof state.input === "object" ? (state.input as Record<string, unknown>) : {};

    if (tool === "read") {
      const filePath = typeof input.filePath === "string" ? normalizePath(input.filePath) : "";
      if (filePath) {
        files.add(filePath);
      } else {
        fileWithoutPath += 1;
      }
      return;
    }

    if (tool === "glob" || tool === "grep" || tool === "search") {
      searches += 1;
      return;
    }

    if (tool === "list" || tool === "list_files") {
      lists += 1;
    }
  });

  return {
    files: files.size + fileWithoutPath,
    searches,
    lists,
  };
}

function formatExplorationSummary(summary: ExplorationSummary) {
  const items: string[] = [];
  if (summary.files > 0) items.push(`${summary.files} file${summary.files === 1 ? "" : "s"}`);
  if (summary.searches > 0) items.push(`${summary.searches} search${summary.searches === 1 ? "" : "es"}`);
  if (summary.lists > 0) items.push(`${summary.lists} list${summary.lists === 1 ? "" : "s"}`);
  return items.length > 0 ? items.join(" · ") : "context activity";
}

function explorationStatus(parts: Part[]) {
  const pending = parts.some((part) => {
    if (part.type !== "tool") return false;
    if (!isExplorationTool(part)) return false;
    const state = (part as any).state ?? {};
    return state.status === "running" || state.status === "pending";
  });
  return pending ? "exploring" : "explored";
}

/** Icon for a given tool category */
function ToolIcon(props: { category: string; size?: number }) {
  const s = () => props.size ?? 12;
  switch (props.category) {
    case "read":
      return <Eye size={s()} />;
    case "edit":
      return <Pencil size={s()} />;
    case "write":
      return <FileEdit size={s()} />;
    case "search":
      return <Search size={s()} />;
    case "terminal":
      return <Terminal size={s()} />;
    case "glob":
      return <FolderSearch size={s()} />;
    case "task":
      return <Sparkles size={s()} />;
    case "skill":
      return <Sparkles size={s()} />;
    default:
      return <File size={s()} />;
  }
}

/** Status dot color */
function statusDotClass(status?: string): string {
  switch (status) {
    case "completed":
    case "done":
      return "bg-green-9";
    case "running":
    case "pending":
      return "bg-blue-9 animate-pulse";
    case "error":
      return "bg-red-9";
    default:
      return "bg-gray-8";
  }
}

function latestStepPart(stepGroups: StepTimelineGroup[]): Part | undefined {
  for (let groupIndex = stepGroups.length - 1; groupIndex >= 0; groupIndex -= 1) {
    const parts = stepGroups[groupIndex]?.parts ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (part.type === "tool" || part.type === "reasoning") {
        return part;
      }
    }
  }
  return undefined;
}

type TaskStepInfo = {
  isTask: boolean;
  agentType?: string;
  sessionId?: string;
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
  const input = state.input && typeof state.input === "object" ? (state.input as Record<string, unknown>) : {};
  const metadata = state.metadata && typeof state.metadata === "object" ? (state.metadata as Record<string, unknown>) : {};

  const rawAgentType = typeof input.subagent_type === "string" ? input.subagent_type.trim() : "";
  const agentType = rawAgentType ? formatAgentType(rawAgentType) : undefined;
  const rawSessionId =
    metadata.sessionId ??
    metadata.sessionID ??
    state.sessionId ??
    state.sessionID;
  const sessionId = typeof rawSessionId === "string" && rawSessionId.trim() ? rawSessionId.trim() : undefined;

  return { isTask: true, agentType, sessionId };
}

export default function MessageList(props: MessageListProps) {
  const [copyingId, setCopyingId] = createSignal<string | null>(null);
  let previousMessagePartCountById = new Map<string, number>();
  let copyTimeout: number | undefined;
  const isAttachmentPart = (part: Part) => {
    if (part.type !== "file") return false;
    const url = (part as { url?: string }).url;
    return typeof url === "string" && !url.startsWith("file://");
  };
  const attachmentsForMessage = (message: MessageWithParts) =>
    message.parts
      .filter(isAttachmentPart)
      .map((part) => {
        const record = part as { url?: string; filename?: string; mime?: string };
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
      const record = part as { label?: string; path?: string; filename?: string };
      const label = record.label ?? record.path ?? record.filename ?? "";
      return label ? `@${label}` : "@file";
    }
    return "";
  };

  const toggleSteps = (id: string, relatedIds: string[] = []) => {
    props.setExpandedStepIds((current) => {
      const next = new Set(current);
      const isExpanded = next.has(id) || relatedIds.some((relatedId) => next.has(relatedId));
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

      if (part.type === "text" || part.type === "tool" || part.type === "agent" || part.type === "file") {
        return true;
      }

      return props.developerMode;
    });

  const messageBlocks = createMemo<MessageBlockItem[]>(() => {
    const startedAt = perfNow();
    const blocks: MessageBlockItem[] = [];
    const nextMessagePartCountById = new Map<string, number>();
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
      if (previousPartCount === undefined) {
        addedMessageCount += 1;
      } else if (previousPartCount !== totalParts) {
        changedMessageCount += 1;
      }

      toolPartCount += renderableParts.reduce((count, part) => (part.type === "tool" ? count + 1 : count), 0);
      const groupId = String((message.info as any).id ?? "message");
      const groups = groupMessageParts(renderableParts, groupId);
      const isUser = (message.info as any).role === "user";
      const isStepsOnly = groups.length > 0 && groups.every((group) => group.kind === "steps");
      const stepGroups = isStepsOnly
        ? (groups as { kind: "steps"; id: string; parts: Part[]; segment: "execution"; mode: StepGroupMode }[])
        : [];
      stepGroupCount += groups.reduce((count, group) => (group.kind === "steps" ? count + 1 : count), 0);

      if (isStepsOnly) {
        blocks.push({
          kind: "steps-cluster",
          id: stepGroups[0].id,
          stepGroups: stepGroups.map((group) => ({ id: group.id, parts: group.parts, mode: group.mode })),
          messageIds: [messageId],
          isUser,
        });
        return;
      }

      blocks.push({
        kind: "message",
        message,
        renderableParts,
        groups,
        isUser,
        messageId,
      });
    });

    let removedMessageCount = 0;
    previousMessagePartCountById.forEach((_partCount, id) => {
      if (!nextMessagePartCountById.has(id)) {
        removedMessageCount += 1;
      }
    });
    previousMessagePartCountById = nextMessagePartCountById;

    const elapsedMs = Math.round((perfNow() - startedAt) * 100) / 100;
    if (
      props.developerMode &&
      (
        elapsedMs >= 6 ||
        (Boolean(props.isStreaming) && props.messages.length >= 16 && changedMessageCount <= 2 && addedMessageCount <= 1 && removedMessageCount === 0) ||
        (Boolean(props.isStreaming) && toolPartCount >= 10)
      )
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

  const shouldUseContentVisibility = createMemo(() => messageBlocks().length > 80);
  const blockPerfStyle = (index: number): JSX.CSSProperties | undefined => {
    if (!shouldUseContentVisibility()) return undefined;
    const total = messageBlocks().length;
    if (index >= total - 24) return undefined;
    return {
      "content-visibility": "auto",
      "contain-intrinsic-size": "220px",
    };
  };

  /** Compact single-line step row */
  const StepRow = (rowProps: { part: Part; isUser: boolean; groupMode?: StepGroupMode }) => {
    const summary = createMemo(() => summarizeStep(rowProps.part));
    const category = createMemo(() => summary().toolCategory ?? "tool");
    const status = createMemo(() => summary().status);
    const task = createMemo(() => getTaskStepInfo(rowProps.part));

    if (rowProps.part.type === "reasoning") {
      return (
        <div class="py-2">
          <div
            class={`rounded-2xl border border-gray-6/60 bg-gray-2/40 px-3 py-2.5 ${
              rowProps.groupMode === "exploration" ? "opacity-85" : ""
            }`}
          >
            <div class="text-[12px] font-medium text-gray-12">{summary().title}</div>
            <Show when={summary().detail}>
              {(detail) => (
                <p class="mt-1 text-[12px] leading-relaxed text-gray-10 whitespace-pre-wrap break-words">
                  {detail()}
                </p>
              )}
            </Show>
          </div>
        </div>
      );
    }

    return (
      <div class="flex items-center gap-2 py-1 min-h-[24px] leading-5 group/step">
        {/* Status dot */}
        <div class={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDotClass(status())}`} />
        {/* Tool icon */}
        <div class={`shrink-0 ${
          summary().isSkill 
            ? "text-purple-10" 
            : "text-gray-9"
        }`}>
          <ToolIcon category={category()} size={13} />
        </div>
        {/* Title */}
        <span class="text-[13px] leading-4 text-gray-12 font-medium truncate shrink-0 max-w-[200px]">
          {summary().title}
        </span>
        {/* Skill badge */}
        <Show when={summary().isSkill}>
          <span class="text-[10px] leading-4 px-1.5 py-0.5 rounded-full bg-purple-3 text-purple-11 shrink-0">
            skill
          </span>
        </Show>
        <Show when={task().isTask}>
          <span class="text-[10px] leading-4 px-1.5 py-0.5 rounded-full bg-blue-3 text-blue-11 shrink-0">
            subagent
          </span>
        </Show>
        {/* Detail - truncated to single line */}
        <Show when={summary().detail}>
          <span class="text-[12px] leading-4 text-gray-9 truncate min-w-0">
            {summary().detail}
          </span>
        </Show>
        <Show when={task().agentType && !summary().detail}>
          {(agentType) => (
            <span class="text-[12px] leading-4 text-gray-9 truncate min-w-0">
              {agentType()} agent
            </span>
          )}
        </Show>
        <Show when={Boolean(task().sessionId && props.openSessionById)}>
          <button
            type="button"
            class="ml-auto text-[11px] text-blue-11 hover:text-blue-10 underline underline-offset-2"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const sessionId = task().sessionId;
              if (!sessionId) return;
              props.openSessionById?.(sessionId);
            }}
          >
            open
          </button>
        </Show>
      </div>
    );
  };

  /** Compact steps list */
  const StepsList = (listProps: { parts: Part[]; isUser: boolean; groupMode: StepGroupMode }) => (
    <div class="divide-y divide-gray-6/40">
      <For each={listProps.parts}>
        {(part) => (
          <div>
            <StepRow part={part} isUser={listProps.isUser} groupMode={listProps.groupMode} />
            <Show when={props.developerMode && part.type !== "reasoning" && (part.type !== "tool" || props.showThinking)}>
              <div class="pl-6 pb-2 text-xs text-gray-10">
                <PartView
                  part={part}
                  developerMode={props.developerMode}
                  showThinking={props.showThinking}
                  workspaceRoot={props.workspaceRoot}
                  tone={listProps.isUser ? "dark" : "light"}
                />
              </div>
            </Show>
          </div>
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
    const relatedIds = () =>
      containerProps.relatedIds ?? containerProps.stepGroups.map((group) => group.id).filter((id) => id !== containerProps.id);
    const expanded = () => isStepsExpanded(containerProps.id, relatedIds());
    const latestStep = () => latestStepPart(containerProps.stepGroups);
    const allStepParts = () => containerProps.stepGroups.flatMap((group) => group.parts);
    const toolCallCount = () =>
      containerProps.stepGroups.reduce(
        (sum, group) => sum + group.parts.reduce((count, part) => (part.type === "tool" ? count + 1 : count), 0),
        0,
      );
    const reasoningCount = () =>
      containerProps.stepGroups.reduce(
        (sum, group) => sum + group.parts.reduce((count, part) => (part.type === "reasoning" ? count + 1 : count), 0),
        0,
      );
    const explorationGroups = () => containerProps.stepGroups.filter((group) => group.mode === "exploration");
    const explorationOnly = () =>
      explorationGroups().length > 0 && explorationGroups().length === containerProps.stepGroups.length;
    const explorationSummary = () => summarizeExploration(explorationGroups().flatMap((group) => group.parts));
    const explorationState = () => explorationStatus(explorationGroups().flatMap((group) => group.parts));

    const executionSummary = () => {
      const tools = toolCallCount();
      const reasoning = reasoningCount();
      if (tools > 0 && reasoning > 0) {
        return `${tools} step${tools === 1 ? "" : "s"} with ${reasoning} thought update${reasoning === 1 ? "" : "s"}`;
      }
      if (tools > 0) {
        return `${tools} step${tools === 1 ? "" : "s"}`;
      }
      if (reasoning > 0) {
        return `${reasoning} thought update${reasoning === 1 ? "" : "s"}`;
      }
      return "updates";
    };

    const compactPathToken = (value: string) => {
      const token = value
        .trim()
        .replace(/^[`'"([{]+|[`'"\])},.;:]+$/g, "");
      const segments = token.split(/[\\/]/).filter(Boolean);
      return segments.length > 0 ? segments[segments.length - 1] : token;
    };

    const compactText = (value: string, max = 42) => {
      const singleLine = value.replace(/\s+/g, " ").trim();
      if (!singleLine) return "";
      return singleLine.length > max ? `${singleLine.slice(0, Math.max(0, max - 3))}...` : singleLine;
    };

    const isPathLike = (value: string) =>
      /^(?:[A-Za-z]:[\\/]|~[\\/]|\/[\w_\-~]|\.\.?[\\/])/.test(value) ||
      /[\\/](?:\.opencode|Users|Library|workspaces)[\\/]/.test(value);

    const toolHeadline = (part: Part) => {
      if (part.type !== "tool") return "";

      const record = part as any;
      const state = record.state ?? {};
      const input = state.input && typeof state.input === "object" ? (state.input as Record<string, unknown>) : {};
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
        return file ? `Read ${file}` : "Read file";
      }

      if (tool === "edit") {
        const file = target("filePath", "path", "file");
        return file ? `Edit ${file}` : "Edit file";
      }

      if (tool === "write" || tool === "apply_patch") {
        const file = target("filePath", "path", "file");
        return file ? `Update ${file}` : "Update file";
      }

      if (tool === "grep" || tool === "glob" || tool === "search") {
        const pattern = pick("pattern", "query");
        return pattern ? `Search ${compactText(pattern, 36)}` : "Search code";
      }

      if (tool === "list" || tool === "list_files") {
        const path = target("path");
        return path ? `List ${path}` : "List files";
      }

      if (tool === "task") {
        const description = pick("description");
        if (description) return compactText(description);
        const agent = pick("subagent_type");
        return agent ? `Delegate ${agent}` : "Delegate task";
      }

      if (tool === "webfetch") {
        const url = pick("url");
        return url ? `Fetch ${compactText(url, 36)}` : "Fetch web page";
      }

      if (tool === "skill") {
        const name = pick("name");
        return name ? `Load skill ${name}` : "Load skill";
      }

      return "";
    };

    const latestStepLabel = () => {
      const step = latestStep();
      if (!step) return "Last step";

      const fromTool = toolHeadline(step);
      if (fromTool) return compactText(fromTool);

      if (step.type === "tool") {
        const toolName = String((step as any).tool ?? "").trim();
        if (toolName) {
          const friendlyTool = toolName.replace(/[_-]+/g, " ");
          return compactText(friendlyTool);
        }
      }

      const summary = summarizeStep(step);
      const title = compactText(summary.title);
      const detail = compactText(summary.detail ?? "");
      const generic = /^(application|tool|step|working|done|completed|success)$/i.test(title);

      if (title && !generic) return title;
      if (detail) return isPathLike(detail) ? compactPathToken(detail) : detail;
      if (title) return title;
      return "Last step";
    };
    const hasRunning = () =>
      allStepParts().some((part) => {
        if (part.type !== "tool") return false;
        const state = (part as any).state ?? {};
        return state.status === "running" || state.status === "pending";
      });
    const useInnerTimelineScroll = () => !(Boolean(props.isStreaming) && hasRunning());

    const collapsedLabel = () => {
      if (explorationOnly()) {
        return explorationState() === "exploring" ? "Exploring" : "Explored";
      }
      return expanded() ? "Hide timeline" : "Execution timeline";
    };

    const collapsedSummary = () => {
      if (explorationOnly()) {
        return formatExplorationSummary(explorationSummary());
      }
      return executionSummary();
    };

    const collapsedDetail = () => {
      if (explorationOnly()) return "";
      if (expanded()) return executionSummary();
      return `${executionSummary()} - ${latestStepLabel()}`;
    };

    const groupHeaderLabel = (group: StepTimelineGroup) => {
      if (group.mode !== "exploration") return "";
      return explorationStatus(group.parts) === "exploring" ? "Exploring" : "Explored";
    };

    const groupHeaderSummary = (group: StepTimelineGroup) => {
      if (group.mode !== "exploration") return "";
      return formatExplorationSummary(summarizeExploration(group.parts));
    };

    return (
      <div class={containerProps.isInline ? (containerProps.isUser ? "mt-2" : "mt-3 pt-3") : ""}>
        {/* Toggle button - clean, compact */}
        <button
          class={`flex items-center gap-2 py-1 leading-5 text-[13px] transition-colors ${
            containerProps.isUser
              ? "text-gray-10 hover:text-gray-11"
              : "text-gray-10 hover:text-gray-12"
          }`}
          onClick={() => toggleSteps(containerProps.id, relatedIds())}
        >
          <ChevronRight
            size={14}
            class={`transition-transform duration-200 ${expanded() ? "rotate-90" : ""}`}
          />
          <span class="font-medium inline-flex items-center gap-1.5 leading-4 text-xs sm:text-[13px] text-gray-11">
            <Show when={hasRunning()}>
              <span class="inline-flex h-1 w-1 rounded-full bg-blue-10/70 animate-pulse" />
            </Show>
            <span class="truncate max-w-[58ch]">{collapsedLabel()}</span>
          </span>
          <Show when={explorationOnly()}>
            <span class="text-[11px] leading-4 text-gray-9 truncate max-w-[46ch]">{collapsedSummary()}</span>
          </Show>
          <Show when={!explorationOnly() && !expanded()}>
            <span class="text-[11px] leading-4 text-gray-9 truncate max-w-[42ch]">{collapsedDetail()}</span>
          </Show>
          <Show when={!explorationOnly() && expanded()}>
            <span class="text-[11px] leading-4 text-gray-9 truncate max-w-[42ch]">{collapsedSummary()}</span>
          </Show>
        </button>

        {/* Expanded content */}
        <Show when={expanded()}>
          <div
            class={`mt-1 ml-1 pl-3 border-l-2 ${useInnerTimelineScroll() ? "max-h-[480px] overflow-y-auto" : ""} ${
              containerProps.isUser
                ? "border-gray-6"
                : "border-gray-6/60"
            }`}
          >
            <For each={containerProps.stepGroups}>
              {(group, index) => (
                <div
                  class={
                    index() === 0
                      ? ""
                      : "mt-2 pt-2 border-t border-gray-6/40"
                  }
                >
                  <Show when={group.mode === "exploration"}>
                    <div class="mb-1 flex items-center gap-2 text-[11px] text-gray-9">
                      <span
                        class={`font-medium ${
                          groupHeaderLabel(group) === "Exploring" ? "text-blue-11" : "text-gray-10"
                        }`}
                      >
                        {groupHeaderLabel(group)}
                      </span>
                      <span class="truncate">{groupHeaderSummary(group)}</span>
                    </div>
                  </Show>
                  <StepsList parts={group.parts} isUser={containerProps.isUser} groupMode={group.mode} />
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    );
  };

  return (
    <div class="space-y-4 pb-24" style={{ contain: "layout paint style" }}>
      <For each={messageBlocks()}>
        {(block, blockIndex) => {
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
                class={`flex group ${block.isUser ? "justify-end" : "justify-start"}`.trim()}
                data-message-role={block.isUser ? "user" : "assistant"}
                data-message-id={block.messageIds[0] ?? ""}
                style={blockPerfStyle(blockIndex())}
              >
                <div
                  class={`w-full relative ${
                    block.isUser
                      ? "max-w-[80%] px-5 py-3 rounded-[24px] bg-gray-3 text-gray-12 text-[14px] leading-relaxed font-medium"
                      : "max-w-[650px] text-[15px] leading-6 text-gray-12 group"
                  } ${searchOutlineClass}`}
                >
                  <StepsContainer
                    id={block.id}
                    relatedIds={block.stepGroups.map((stepGroup) => stepGroup.id).filter((stepId) => stepId !== block.id)}
                    stepGroups={block.stepGroups}
                    isUser={block.isUser}
                  />
                </div>
              </div>
            );
          }

          const groupSpacing = block.isUser ? "mb-3" : "mb-4";
          return (
            <div
              class={`flex group ${block.isUser ? "justify-end" : "justify-start"}`.trim()}
              data-message-role={block.isUser ? "user" : "assistant"}
              data-message-id={block.messageId}
              style={blockPerfStyle(blockIndex())}
            >
              <div
                class={`w-full relative ${
                  block.isUser
                    ? "max-w-[80%] px-5 py-3 rounded-[24px] bg-gray-3 text-gray-12 text-[14px] leading-relaxed font-medium"
                    : "max-w-[650px] text-[15px] leading-[1.65] text-gray-12 font-serif antialiased group"
                } ${searchOutlineClass}`}
              >
                <Show when={attachmentsForMessage(block.message).length > 0}>
                  <div class={block.isUser ? "mb-3 flex flex-wrap gap-2" : "mb-4 flex flex-wrap gap-2"}>
                    <For each={attachmentsForMessage(block.message)}>
                      {(attachment) => (
                        <div class="flex items-center gap-2 rounded-2xl border border-gray-6 bg-gray-1/70 px-3 py-2 text-xs text-gray-11">
                          <Show
                            when={isImageAttachment(attachment.mime)}
                            fallback={<File size={14} class="text-gray-9" />}
                          >
                            <div class="h-12 w-12 rounded-xl bg-gray-2 overflow-hidden border border-gray-6">
                              <img
                                src={attachment.url}
                                alt={attachment.filename}
                                class="h-full w-full object-cover"
                              />
                            </div>
                          </Show>
                          <div class="max-w-[180px]">
                            <div class="truncate text-gray-12">{attachment.filename}</div>
                            <div class="text-[10px] text-gray-9">{attachment.mime}</div>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
                <For each={block.groups}>
                  {(group, idx) => (
                    <div class={idx() === block.groups.length - 1 ? "" : groupSpacing}>
                      <Show when={group.kind === "text"}>
                        {(() => {
                          const isStreamingLatestAssistant =
                            !block.isUser && props.isStreaming && block.messageId === latestAssistantMessageId();
                          const markdownThrottleMs = isStreamingLatestAssistant ? 550 : 100;
                          return (
                            <PartView
                              part={(group as { kind: "text"; part: Part; segment: "intent" | "result" }).part}
                              developerMode={props.developerMode}
                              showThinking={props.showThinking}
                              workspaceRoot={props.workspaceRoot}
                              tone={block.isUser ? "dark" : "light"}
                              renderMarkdown={!block.isUser}
                              markdownThrottleMs={markdownThrottleMs}
                              highlightQuery={hasSearchMatch ? props.searchHighlightQuery : undefined}
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
                              stepGroups={[{ id: stepGroup.id, parts: stepGroup.parts, mode: stepGroup.mode }]}
                              isUser={block.isUser}
                              isInline={true}
                            />
                          );
                        })()}
                    </div>
                  )}
                </For>
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
                    <Show when={copyingId() === block.messageId} fallback={<Copy size={12} />}>
                      <Check size={12} class="text-green-10" />
                    </Show>
                  </button>
                </div>
              </div>
            </div>
          );
        }}
      </For>
      <Show when={props.footer}>{props.footer}</Show>
    </div>
  );
}
