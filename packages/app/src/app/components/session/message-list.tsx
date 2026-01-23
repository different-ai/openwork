import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import type { Part } from "@opencode-ai/sdk/v2/client";
import { Check, ChevronDown, Circle, Copy, File, FileText } from "lucide-solid";

import type { ArtifactItem, MessageWithParts } from "../../types";
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

  const toggleSteps = (id: string) => {
    props.setExpandedStepIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

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

  return (
    <div class="max-w-3xl mx-auto space-y-6 pb-32 px-4">
      <For each={props.messages}>
        {(msg) => {
          const isUser = () => (msg.info as any).role === "user";
          const renderableParts = () =>
            msg.parts.filter((p) => {
              if (p.type === "reasoning") {
                return props.developerMode && props.showThinking;
              }

              if (p.type === "step-start" || p.type === "step-finish") {
                return props.developerMode;
              }

              if (p.type === "text" || p.type === "tool") {
                return true;
              }

              return props.developerMode;
            });

          const groups = () =>
            groupMessageParts(renderableParts(), String((msg.info as any).id ?? "message"));
          const groupSpacing = () => (isUser() ? "mb-3" : "mb-4");
          const messageId = () => String((msg.info as any).id ?? "");
          const messageArtifacts = () => artifactsByMessage().get(messageId()) ?? [];

          return (
            <Show when={renderableParts().length > 0}>
              <div
                class={`flex group ${isUser() ? "justify-end" : "justify-start"}`.trim()}
                data-message-role={isUser() ? "user" : "assistant"}
                data-message-id={messageId()}
              >
                <div
                  class={`w-full relative ${
                    isUser()
                      ? "max-w-2xl px-6 py-4 rounded-[24px] bg-gray-3 text-gray-12 text-[15px] leading-relaxed"
                      : "max-w-[68ch] text-[15px] leading-7 text-gray-12 group pl-2"
                  }`}
                >
                  <For each={groups()}>
                    {(group, idx) => (
                      <div class={idx() === groups().length - 1 ? "" : groupSpacing()}>
                        <Show when={group.kind === "text"}>
                          <PartView
                            part={(group as { kind: "text"; part: Part }).part}
                            developerMode={props.developerMode}
                            showThinking={props.showThinking}
                            tone={isUser() ? "dark" : "light"}
                            renderMarkdown={!isUser()}
                          />
                        </Show>
                        <Show when={group.kind === "steps"}>
                          <div class={isUser() ? "mt-2" : "mt-3 border-t border-gray-6/60 pt-3"}>
                            <button
                              class={`flex items-center gap-2 text-xs ${
                                isUser() ? "text-gray-10 hover:text-gray-11" : "text-gray-10 hover:text-gray-12"
                              }`}
                              onClick={() => toggleSteps((group as any).id)}
                            >
                              <span>
                                {props.expandedStepIds.has((group as any).id)
                                  ? "Hide steps"
                                  : "View steps"}
                              </span>
                              <ChevronDown
                                size={14}
                                class={`transition-transform ${
                                  props.expandedStepIds.has((group as any).id) ? "rotate-180" : ""
                                }`.trim()}
                              />
                            </button>
                            <Show when={props.expandedStepIds.has((group as any).id)}>
                              <div
                                class={`mt-3 space-y-3 rounded-xl border p-3 ${
                                  isUser()
                                    ? "border-gray-6 bg-gray-1/60"
                                    : "border-gray-6/70 bg-gray-2/40"
                                }`}
                              >
                                <For each={(group as any).parts as Part[]}>
                                  {(part) => {
                                    const summary = summarizeStep(part);
                                    return (
                                      <div class="flex items-start gap-3 text-xs text-gray-11">
                                        <div class="mt-0.5 h-5 w-5 rounded-full border border-gray-7 flex items-center justify-center text-gray-10">
                                          {part.type === "tool" ? (
                                            <File size={12} />
                                          ) : (
                                            <Circle size={8} />
                                          )}
                                        </div>
                                        <div>
                                          <div class="text-gray-12">{summary.title}</div>
                                          <Show when={summary.detail}>
                                            <div class="mt-1 text-gray-10">{summary.detail}</div>
                                          </Show>
                                          <Show
                                            when={
                                              props.developerMode &&
                                              (part.type !== "tool" || props.showThinking)
                                            }
                                          >
                                            <div class="mt-2 text-xs text-gray-10">
                                              <PartView
                                                part={part}
                                                developerMode={props.developerMode}
                                                showThinking={props.showThinking}
                                                tone={isUser() ? "dark" : "light"}
                                              />
                                            </div>
                                          </Show>
                                        </div>
                                      </div>
                                    );
                                  }}
                                </For>
                              </div>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                  <Show when={messageArtifacts().length}>
                    <div class={`mt-4 space-y-2 ${isUser() ? "text-gray-12" : ""}`.trim()}>
                      <div class="text-[11px] uppercase tracking-wide text-gray-9">Artifacts</div>
                      <For each={messageArtifacts()}>
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
                        const text = renderableParts()
                          .map((p) => ("text" in p ? (p as any).text : ""))
                          .join("\n");
                        handleCopy(text, messageId());
                      }}
                    >
                      <Show when={copyingId() === messageId()} fallback={<Copy size={12} />}>
                        <Check size={12} class="text-green-10" />
                      </Show>
                    </button>
                  </div>
                </div>
              </div>
            </Show>
          );
        }}
      </For>
    </div>
  );
}
