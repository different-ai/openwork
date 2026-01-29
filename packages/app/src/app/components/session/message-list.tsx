import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import type { Part } from "@opencode-ai/sdk/v2/client";
import { Check, ChevronDown, Circle, Copy, File, Sparkles } from "lucide-solid";

import type { MessageGroup, MessageWithParts } from "../../types";
import { groupMessageParts, summarizeStep } from "../../utils";
import PartView from "../part-view";

export type MessageListProps = {
  messages: MessageWithParts[];
  developerMode: boolean;
  showThinking: boolean;
  expandedStepIds: Set<string>;
  setExpandedStepIds: (updater: (current: Set<string>) => Set<string>) => void;
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
      const expanded = next.has(id) || relatedIds.some((relatedId) => next.has(relatedId));
      if (expanded) {
        next.delete(id);
        relatedIds.forEach((relatedId) => next.delete(relatedId));
      } else {
        next.add(id);
        relatedIds.forEach((relatedId) => next.delete(relatedId));
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

  const StepsList = (listProps: { parts: Part[]; isUser: boolean }) => (
    <div class="space-y-3">
      <For each={listProps.parts}>
        {(part) => {
          const summary = summarizeStep(part);
          return (
            <div class="flex items-start gap-3 text-xs text-gray-11">
              <div class={`mt-0.5 h-5 w-5 rounded-full border flex items-center justify-center ${
                summary.isSkill 
                  ? "border-purple-7 bg-purple-3 text-purple-10" 
                  : "border-gray-7 text-gray-10"
              }`}>
                {summary.isSkill ? <Sparkles size={12} /> : part.type === "tool" ? <File size={12} /> : <Circle size={8} />}
              </div>
              <div class="flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-gray-12">{summary.title}</span>
                  <Show when={summary.isSkill}>
                    <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                      skill
                    </span>
                  </Show>
                </div>
                <Show when={summary.detail}>
                  <div class="mt-1 text-gray-10">{summary.detail}</div>
                </Show>
                <Show when={props.developerMode && (part.type !== "tool" || props.showThinking)}>
                  <div class="mt-2 text-xs text-gray-10">
                    <PartView
                      part={part}
                      developerMode={props.developerMode}
                      showThinking={props.showThinking}
                      tone={listProps.isUser ? "dark" : "light"}
                    />
                  </div>
                </Show>
              </div>
            </div>
          );
        }}
      </For>
    </div>
  );

  return (
    <div class="max-w-3xl mx-auto space-y-6 pb-32 px-4">
      <For each={messageBlocks()}>
        {(block) => {
          if (block.kind === "steps-cluster") {
            const relatedStepIds = block.stepIds.filter((stepId) => stepId !== block.id);
            const expanded = () => isStepsExpanded(block.id, relatedStepIds);
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
                  }`}
                >
                  <div class={block.isUser ? "mt-2" : "mt-3 border-t border-gray-6/60 pt-3"}>
                    <button
                      class={`flex items-center gap-2 text-xs ${
                        block.isUser ? "text-gray-10 hover:text-gray-11" : "text-gray-10 hover:text-gray-12"
                      }`}
                      onClick={() => toggleSteps(block.id, relatedStepIds)}
                    >
                      <span>{expanded() ? "Hide steps" : "View steps"}</span>
                      <ChevronDown
                        size={14}
                        class={`transition-transform ${expanded() ? "rotate-180" : ""}`.trim()}
                      />
                    </button>
                    <Show when={expanded()}>
                      <div
                        class={`mt-3 rounded-xl border p-3 ${
                          block.isUser
                            ? "border-gray-6 bg-gray-1/60"
                            : "border-gray-6/70 bg-gray-2/40"
                        }`}
                      >
                        <For each={block.partsGroups}>
                          {(parts, index) => (
                            <div
                              class={
                                index() === 0
                                  ? ""
                                  : "mt-3 pt-3 border-t border-gray-6/60"
                              }
                            >
                              <StepsList parts={parts} isUser={block.isUser} />
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
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
                }`}
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
                          tone={block.isUser ? "dark" : "light"}
                          renderMarkdown={!block.isUser}
                        />
                      </Show>
                      {group.kind === "steps" &&
                        (() => {
                          const stepGroup = group as { kind: "steps"; id: string; parts: Part[] };
                          const expanded = () => isStepsExpanded(stepGroup.id);
                          return (
                            <div class={block.isUser ? "mt-2" : "mt-3 border-t border-gray-6/60 pt-3"}>
                              <button
                                class={`flex items-center gap-2 text-xs ${
                                  block.isUser
                                    ? "text-gray-10 hover:text-gray-11"
                                    : "text-gray-10 hover:text-gray-12"
                                }`}
                                onClick={() => toggleSteps(stepGroup.id)}
                              >
                                <span>{expanded() ? "Hide steps" : "View steps"}</span>
                                <ChevronDown
                                  size={14}
                                  class={`transition-transform ${expanded() ? "rotate-180" : ""}`.trim()}
                                />
                              </button>
                              <Show when={expanded()}>
                                <div
                                  class={`mt-3 rounded-xl border p-3 ${
                                    block.isUser
                                      ? "border-gray-6 bg-gray-1/60"
                                      : "border-gray-6/70 bg-gray-2/40"
                                  }`}
                                >
                                  <StepsList parts={stepGroup.parts} isUser={block.isUser} />
                                </div>
                              </Show>
                            </div>
                          );
                        })()}
                    </div>
                  )}
                </For>
                <div class="absolute bottom-2 right-2 flex justify-end opacity-0 group-hover:opacity-100 transition-opacity select-none pointer-events-none group-hover:pointer-events-auto">
                  <button
                    class="text-gray-9 hover:text-gray-11 p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
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
