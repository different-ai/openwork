import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import type { Part } from "@opencode-ai/sdk/v2/client";
import { Check, Copy, File } from "lucide-solid";

import type { MessageGroup, MessageWithParts } from "../../types";
import { groupMessageParts, summarizeStep } from "../../utils";
import PartView from "../part-view";

export type MessageListProps = {
  messages: MessageWithParts[];
  developerMode: boolean;
  showThinking: boolean;
  searchMatchMessageIds?: ReadonlySet<string>;
  activeSearchMessageId?: string | null;
  workspaceRoot?: string;
  footer?: JSX.Element;
};

type MessageBlock = {
  message: MessageWithParts;
  renderableParts: Part[];
  groups: MessageGroup[];
  isUser: boolean;
  messageId: string;
};

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

  const messageBlocks = createMemo<MessageBlock[]>(() =>
    props.messages
      .map((message) => {
        const renderableParts = renderablePartsForMessage(message);
        if (!renderableParts.length) return null;

        const messageId = String((message.info as any).id ?? "");
        const groupId = String((message.info as any).id ?? "message");
        const groups = groupMessageParts(renderableParts, groupId);
        const isUser = (message.info as any).role === "user";

        return {
          message,
          renderableParts,
          groups,
          isUser,
          messageId,
        };
      })
      .filter((block): block is MessageBlock => block !== null),
  );

  /** Compact single-line step row */
  const StepRow = (rowProps: { part: Part; isUser: boolean }) => {
    const summary = createMemo(() => summarizeStep(rowProps.part));
    const status = createMemo(() => summary().status);
    const label = createMemo(() => {
      if (rowProps.part.type === "tool") {
        const record = rowProps.part as any;
        if (record.tool === "bash") {
          const state = record.state ?? {};
          const input = state.input && typeof state.input === "object" ? (state.input as Record<string, unknown>) : {};
          const command = typeof input.command === "string" ? input.command.trim() : "";
          if (command) {
            return `${status() === "completed" ? "Ran" : "Run"} ${command}`;
          }
        }
      }
      return summary().title;
    });

    const detail = createMemo(() => {
      if (rowProps.part.type === "tool" && (rowProps.part as any).tool === "bash") {
        return undefined;
      }
      return summary().detail;
    });

    return (
      <div class="flex items-center gap-2 py-1 text-[14px] leading-6">
        {/* Status dot */}
        <div class={`w-1.5 h-1.5 rounded-full shrink-0 mt-[1px] ${statusDotClass(status())}`} />
        <span class="text-gray-11 truncate shrink-0 max-w-[320px]">
          {label()}
        </span>
        <Show when={detail()}>
          <span class="text-[12px] text-gray-9 truncate min-w-0">
            {detail()}
          </span>
        </Show>
      </div>
    );
  };

  /** Compact steps list */
  const StepsList = (listProps: { parts: Part[]; isUser: boolean }) => (
    <div class="space-y-0.5">
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

  const StepsContainer = (containerProps: { parts: Part[]; isUser: boolean; isInline?: boolean }) => (
    <div class={containerProps.isInline ? (containerProps.isUser ? "mt-2" : "mt-2") : ""}>
      <StepsList parts={containerProps.parts} isUser={containerProps.isUser} />
    </div>
  );

  return (
    <div class="space-y-6 pb-32">
      <For each={messageBlocks()}>
        {(block) => {
          const hasSearchMatch = props.searchMatchMessageIds?.has(block.messageId) ?? false;
          const hasActiveSearchMatch = block.messageId === props.activeSearchMessageId;
          const searchOutlineClass = hasActiveSearchMatch
            ? "outline outline-2 outline-amber-8/70 outline-offset-2 rounded-2xl"
            : hasSearchMatch
              ? "outline outline-1 outline-amber-7/50 outline-offset-1 rounded-2xl"
              : "";

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
                              parts={stepGroup.parts}
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
