import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import type { Part } from "@opencode-ai/sdk/v2/client";
import { Check, ChevronDown, Circle, Copy, File, FileText } from "lucide-solid";

import type { ArtifactItem, MessageGroup, MessageWithParts } from "../../types";
import { groupMessageParts, summarizeStep } from "../../utils";
import Button from "../button";
import PartView from "../part-view";

export type MessageListProps = {
  messages: MessageWithParts[];
  artifacts: ArtifactItem[];
  developerMode: boolean;
  showThinking: boolean;
  expandedStepIds: Set<string>;
  setExpandedStepIds: (updater: (current: Set<string>) => Set<string>) => void;
  onOpenArtifact: (artifact: ArtifactItem) => void;
};

type StepClusterBlock = {
  kind: "steps-cluster";
  id: string;
  stepIds: string[];
  partsGroups: Part[][];
  messageIds: string[];
  isUser: boolean;
  artifacts: ArtifactItem[];
};

type MessageBlock = {
  kind: "message";
  message: MessageWithParts;
  renderableParts: Part[];
  groups: MessageGroup[];
  isUser: boolean;
  messageId: string;
  artifacts: ArtifactItem[];
};

type MessageBlockItem = MessageBlock | StepClusterBlock;

export default function MessageList(props: MessageListProps) {
  const [copyingId, setCopyingId] = createSignal<string | null>(null);
  let copyTimeout: number | undefined;

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

      if (part.type === "text" || part.type === "tool") {
        return true;
      }

      return props.developerMode;
    });

  const artifactsByMessage = createMemo(() => {
    const map = new Map<string, ArtifactItem[]>();
    for (const artifact of props.artifacts) {
      const key = artifact.messageId?.trim();
      if (!key) continue;
      const current = map.get(key);
      if (current) {
        current.push(artifact);
      } else {
        map.set(key, [artifact]);
      }
    }
    return map;
  });

  const messageBlocks = createMemo<MessageBlockItem[]>(() => {
    const blocks: MessageBlockItem[] = [];
    const artifactMap = artifactsByMessage();

    for (const message of props.messages) {
      const renderableParts = renderablePartsForMessage(message);
      if (!renderableParts.length) continue;

      const messageId = String((message.info as any).id ?? "");
      const groupId = String((message.info as any).id ?? "message");
      const groups = groupMessageParts(renderableParts, groupId);
      const isUser = (message.info as any).role === "user";
      const messageArtifacts = artifactMap.get(messageId) ?? [];
      const isStepsOnly = groups.length === 1 && groups[0].kind === "steps";

      if (isStepsOnly) {
        const stepGroup = groups[0] as { kind: "steps"; id: string; parts: Part[] };
        const lastBlock = blocks[blocks.length - 1];
        if (lastBlock && lastBlock.kind === "steps-cluster" && lastBlock.isUser === isUser) {
          lastBlock.partsGroups.push(stepGroup.parts);
          lastBlock.stepIds.push(stepGroup.id);
          lastBlock.messageIds.push(messageId);
          if (messageArtifacts.length) {
            lastBlock.artifacts.push(...messageArtifacts);
          }
        } else {
          blocks.push({
            kind: "steps-cluster",
            id: stepGroup.id,
            stepIds: [stepGroup.id],
            partsGroups: [stepGroup.parts],
            messageIds: [messageId],
            isUser,
            artifacts: [...messageArtifacts],
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
        artifacts: messageArtifacts,
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
              <div class="mt-0.5 h-5 w-5 rounded-full border border-gray-7 flex items-center justify-center text-gray-10">
                {part.type === "tool" ? <File size={12} /> : <Circle size={8} />}
              </div>
              <div>
                <div class="text-gray-12">{summary.title}</div>
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
                  <Show when={block.artifacts.length}>
                    <div class={`mt-4 space-y-2 ${block.isUser ? "text-gray-12" : ""}`.trim()}>
                      <div class="text-[11px] uppercase tracking-wide text-gray-9">Artifacts</div>
                      <For each={block.artifacts}>
                        {(artifact) => (
                          <div
                            class="rounded-2xl border border-gray-6 bg-gray-1/60 px-4 py-3 flex items-center justify-between"
                            data-artifact-id={artifact.id}
                          >
                            <div class="flex items-center gap-3">
                              <div class="h-9 w-9 rounded-lg bg-gray-2 flex items-center justify-center">
                                <FileText size={16} class="text-gray-10" />
                              </div>
                              <div>
                                <div class="text-sm text-gray-12">{artifact.name}</div>
                                <div class="text-xs text-gray-10">Document</div>
                              </div>
                            </div>
                            <Button
                              variant="outline"
                              class="text-xs"
                              onClick={() => props.onOpenArtifact(artifact)}
                            >
                              Open
                            </Button>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
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
                      <Show when={group.kind === "steps"}>
                        {() => {
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
                        }}
                      </Show>
                    </div>
                  )}
                </For>
                <Show when={block.artifacts.length}>
                  <div class={`mt-4 space-y-2 ${block.isUser ? "text-gray-12" : ""}`.trim()}>
                    <div class="text-[11px] uppercase tracking-wide text-gray-9">Artifacts</div>
                    <For each={block.artifacts}>
                      {(artifact) => (
                        <div
                          class="rounded-2xl border border-gray-6 bg-gray-1/60 px-4 py-3 flex items-center justify-between"
                          data-artifact-id={artifact.id}
                        >
                          <div class="flex items-center gap-3">
                            <div class="h-9 w-9 rounded-lg bg-gray-2 flex items-center justify-center">
                              <FileText size={16} class="text-gray-10" />
                            </div>
                            <div>
                              <div class="text-sm text-gray-12">{artifact.name}</div>
                              <div class="text-xs text-gray-10">Document</div>
                            </div>
                          </div>
                          <Button
                            variant="outline"
                            class="text-xs"
                            onClick={() => props.onOpenArtifact(artifact)}
                          >
                            Open
                          </Button>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                <div class="mt-2 flex justify-end opacity-0 group-hover:opacity-100 transition-opacity select-none">
                  <button
                    class="text-gray-9 hover:text-gray-11 p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                    title="Copy message"
                    onClick={() => {
                      const text = block.renderableParts
                        .map((part) => ("text" in part ? (part as any).text : ""))
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
    </div>
  );
}
