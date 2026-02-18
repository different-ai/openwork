import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import type { Part } from "@opencode-ai/sdk/v2/client";
import { Check, ChevronDown, ChevronRight, Copy, Eye, File, FileEdit, FolderSearch, Pencil, Search, Sparkles, Terminal } from "lucide-solid";

import type { MessageGroup, MessageWithParts } from "../../types";
import { groupMessageParts, summarizeStep } from "../../utils";
import PartView from "../part-view";

export type MessageListProps = {
  messages: MessageWithParts[];
  developerMode: boolean;
  showThinking: boolean;
  expandedStepIds: Set<string>;
  setExpandedStepIds: (updater: (current: Set<string>) => Set<string>) => void;
  searchMatchMessageIds?: ReadonlySet<string>;
  activeSearchMessageId?: string | null;
  workspaceRoot?: string;
  footer?: JSX.Element;
};

type StepClusterBlock = {
  kind: "steps-cluster";
  id: string;
  stepIds: string[];
  partsGroups: Part[][];
  messageIds: string[];
  isUser: boolean;
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

function latestStepPart(partsGroups: Part[][]): Part | undefined {
  for (let groupIndex = partsGroups.length - 1; groupIndex >= 0; groupIndex -= 1) {
    const parts = partsGroups[groupIndex] ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (
        part.type === "tool" ||
        part.type === "reasoning" ||
        part.type === "step-start" ||
        part.type === "step-finish"
      ) {
        return part;
      }
    }
  }
  return undefined;
}

export default function MessageList(props: MessageListProps) {
  const [copyingId, setCopyingId] = createSignal<string | null>(null);
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
      if (part.type === "reasoning") {
        return props.developerMode && props.showThinking;
      }

      if (part.type === "step-start" || part.type === "step-finish") {
        return props.developerMode;
      }

      if (part.type === "text" || part.type === "tool" || part.type === "agent" || part.type === "file") {
        return true;
      }

      return props.developerMode;
    });

  const messageBlocks = createMemo<MessageBlockItem[]>(() => {
    const blocks: MessageBlockItem[] = [];

    for (const message of props.messages) {
      const renderableParts = renderablePartsForMessage(message);
      if (!renderableParts.length) continue;

      const messageId = String((message.info as any).id ?? "");
      const groupId = String((message.info as any).id ?? "message");
      const groups = groupMessageParts(renderableParts, groupId);
      const isUser = (message.info as any).role === "user";
      const isStepsOnly = groups.length === 1 && groups[0].kind === "steps";

      if (isStepsOnly) {
        const stepGroup = groups[0] as { kind: "steps"; id: string; parts: Part[] };
        const lastBlock = blocks[blocks.length - 1];
        if (lastBlock && lastBlock.kind === "steps-cluster" && lastBlock.isUser === isUser) {
          lastBlock.partsGroups.push(stepGroup.parts);
          lastBlock.stepIds.push(stepGroup.id);
          lastBlock.messageIds.push(messageId);
        } else {
          blocks.push({
            kind: "steps-cluster",
            id: stepGroup.id,
            stepIds: [stepGroup.id],
            partsGroups: [stepGroup.parts],
            messageIds: [messageId],
            isUser,
          });
        }
        continue;
      }

      blocks.push({
        kind: "message",
        message,
        renderableParts,
        groups,
        isUser,
        messageId,
      });
    }

    return blocks;
  });

  /** Compact single-line step row */
  const StepRow = (rowProps: { part: Part; isUser: boolean }) => {
    const summary = createMemo(() => summarizeStep(rowProps.part));
    const category = createMemo(() => summary().toolCategory ?? "tool");
    const status = createMemo(() => summary().status);

    return (
      <div class="flex items-center gap-2.5 py-1.5 min-h-[28px] group/step">
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
        <span class="text-[13px] text-gray-12 font-medium truncate shrink-0 max-w-[200px]">
          {summary().title}
        </span>
        {/* Skill badge */}
        <Show when={summary().isSkill}>
          <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-3 text-purple-11 shrink-0">
            skill
          </span>
        </Show>
        {/* Detail - truncated to single line */}
        <Show when={summary().detail}>
          <span class="text-[12px] text-gray-9 truncate min-w-0">
            {summary().detail}
          </span>
        </Show>
      </div>
    );
  };

  /** Compact steps list */
  const StepsList = (listProps: { parts: Part[]; isUser: boolean }) => (
    <div class="divide-y divide-gray-6/40">
      <For each={listProps.parts}>
        {(part) => (
          <div>
            <StepRow part={part} isUser={listProps.isUser} />
            <Show when={props.developerMode && (part.type !== "tool" || props.showThinking)}>
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
    partsGroups: Part[][];
    isUser: boolean;
    isInline?: boolean;
  }) => {
    const relatedIds = () => containerProps.relatedIds ?? [];
    const expanded = () => isStepsExpanded(containerProps.id, relatedIds());
    const latestStep = () => latestStepPart(containerProps.partsGroups);

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

      if (tool === "grep" || tool === "glob") {
        const pattern = pick("pattern", "query");
        return pattern ? `Search ${compactText(pattern, 36)}` : "Search code";
      }

      if (tool === "list") {
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
      containerProps.partsGroups.some((parts) =>
        parts.some((part) => {
          if (part.type !== "tool") return false;
          const state = (part as any).state ?? {};
          return state.status === "running" || state.status === "pending";
        }),
      );

    return (
      <div class={containerProps.isInline ? (containerProps.isUser ? "mt-2" : "mt-3 pt-3") : ""}>
        {/* Toggle button - clean, compact */}
        <button
          class={`flex items-center gap-2 py-1.5 text-[13px] transition-colors ${
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
          <span class="font-medium inline-flex items-center gap-1.5 text-xs sm:text-[13px] text-gray-11">
            <Show when={hasRunning()}>
              <span class="inline-flex h-1 w-1 rounded-full bg-blue-10/70 animate-pulse" />
            </Show>
            <span class="truncate max-w-[58ch]">{latestStepLabel()}</span>
          </span>
        </button>

        {/* Expanded content */}
        <Show when={expanded()}>
          <div
            class={`mt-1 ml-1 pl-3 border-l-2 max-h-[480px] overflow-y-auto ${
              containerProps.isUser
                ? "border-gray-6"
                : "border-gray-6/60"
            }`}
          >
            <For each={containerProps.partsGroups}>
              {(parts, index) => (
                <div
                  class={
                    index() === 0
                      ? ""
                      : "mt-2 pt-2 border-t border-gray-6/40"
                  }
                >
                  <StepsList parts={parts} isUser={containerProps.isUser} />
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    );
  };

  return (
    <div class="space-y-6 pb-32">
      <For each={messageBlocks()}>
        {(block) => {
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
              >
                <div
                  class={`w-full relative ${
                    block.isUser
                      ? "max-w-2xl px-6 py-4 rounded-[24px] bg-gray-3 text-gray-12 text-[15px] leading-relaxed"
                      : "max-w-[68ch] text-[15px] leading-7 text-gray-12 group pl-2"
                  } ${searchOutlineClass}`}
                >
                  <StepsContainer
                    id={block.id}
                    relatedIds={block.stepIds.filter((stepId) => stepId !== block.id)}
                    partsGroups={block.partsGroups}
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
            >
              <div
                class={`w-full relative ${
                  block.isUser
                    ? "max-w-2xl px-6 py-4 rounded-[24px] bg-gray-3 text-gray-12 text-[15px] leading-relaxed"
                    : "max-w-[68ch] text-[15px] leading-7 text-gray-12 group pl-2"
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
                        <PartView
                          part={(group as { kind: "text"; part: Part }).part}
                          developerMode={props.developerMode}
                          showThinking={props.showThinking}
                          workspaceRoot={props.workspaceRoot}
                          tone={block.isUser ? "dark" : "light"}
                          renderMarkdown={!block.isUser}
                        />
                      </Show>
                      {group.kind === "steps" &&
                        (() => {
                          const stepGroup = group as { kind: "steps"; id: string; parts: Part[] };
                          return (
                            <StepsContainer
                              id={stepGroup.id}
                              partsGroups={[stepGroup.parts]}
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
