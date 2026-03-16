import { For, Show, createEffect } from "solid-js";
import { Bot, Brain, Sparkles, X } from "lucide-solid";

import type { ModelStyleOption } from "../utils/model-style";
import Button from "./button";

export type AiDefaultsModalProps = {
  open: boolean;
  busy: boolean;
  defaultModelLabel: string;
  defaultModelRef: string;
  assistantHint: string;
  answerStyleLabel: string;
  answerStyleHint: string;
  answerStyleUnavailable: boolean;
  answerStyleId: ModelStyleOption["id"];
  answerStyleRawValue: string | null;
  answerStyleOptions: ModelStyleOption[];
  showThinking: boolean;
  autoCompactContext: boolean;
  developerMode: boolean;
  onChooseModel: () => void;
  onSelectAnswerStyle: (value: string | null) => void;
  onToggleShowThinking: () => void;
  onToggleAutoCompactContext: () => void;
  onClose: () => void;
};

const optionActive = (
  option: ModelStyleOption,
  selectedId: ModelStyleOption["id"],
  selectedRawValue: string | null,
) => {
  if (option.rawValue === null) return selectedRawValue === null;
  if (selectedRawValue === option.rawValue) return true;
  return selectedId === option.id;
};

export default function AiDefaultsModal(props: AiDefaultsModalProps) {
  createEffect(() => {
    if (!props.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-4">
        <div class="w-full max-w-2xl rounded-[28px] border border-gray-6/70 bg-gray-2 shadow-2xl overflow-hidden">
          <div class="border-b border-gray-6/60 px-6 py-5 sm:px-7">
            <div class="flex items-start justify-between gap-4">
              <div class="space-y-2">
                <div class="inline-flex items-center gap-2 rounded-full border border-blue-7/35 bg-blue-4/20 px-3 py-1 text-[11px] font-medium text-blue-11">
                  <Sparkles size={12} />
                  Your AI defaults
                </div>
                <div>
                  <h3 class="text-xl font-semibold text-gray-12">How should OpenWork help?</h3>
                  <p class="mt-1 max-w-[56ch] text-sm text-gray-10">
                    Pick your default assistant and how thoughtful you want new runs to feel.
                  </p>
                </div>
              </div>

              <Button variant="ghost" class="!p-2 rounded-full" onClick={props.onClose}>
                <X size={16} />
              </Button>
            </div>
          </div>

          <div class="space-y-6 px-6 py-6 sm:px-7">
            <section class="rounded-[24px] border border-gray-6/70 bg-gray-1/45 p-5">
              <div class="flex items-start justify-between gap-4">
                <div class="flex items-start gap-4 min-w-0">
                  <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-gray-6/70 bg-gray-1 text-gray-12">
                    <Bot size={18} />
                  </div>
                  <div class="min-w-0">
                    <div class="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-9">
                      Default assistant
                    </div>
                    <div class="mt-1 text-base font-semibold text-gray-12 truncate">{props.defaultModelLabel}</div>
                    <div class="mt-1 text-xs font-mono text-gray-8 truncate">{props.defaultModelRef}</div>
                    <div class="mt-3 max-w-[52ch] text-sm text-gray-10">{props.assistantHint}</div>
                  </div>
                </div>

                <Button
                  variant="outline"
                  class="shrink-0 rounded-xl px-3 py-2 text-xs font-semibold"
                  onClick={props.onChooseModel}
                  disabled={props.busy}
                >
                  Change assistant
                </Button>
              </div>
            </section>

            <section class="rounded-[24px] border border-gray-6/70 bg-gray-1/45 p-5 space-y-4">
              <div class="flex items-start gap-4">
                <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-gray-6/70 bg-gray-1 text-gray-12">
                  <Brain size={18} />
                </div>
                <div>
                  <div class="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-9">
                    Answer style for {props.defaultModelLabel}
                  </div>
                  <div class="mt-1 text-base font-semibold text-gray-12">{props.answerStyleLabel}</div>
                  <div class="mt-1 max-w-[54ch] text-sm text-gray-10">{props.answerStyleHint}</div>
                  <div class="mt-2 text-xs text-gray-8">
                    Styles vary by assistant. OpenWork maps each one to the closest mode this assistant supports.
                  </div>
                </div>
              </div>

              <Show
                when={props.answerStyleOptions.length > 0}
                fallback={
                  <div class="rounded-2xl border border-gray-6/70 bg-gray-1/55 px-4 py-4 text-sm text-gray-10">
                    {props.answerStyleUnavailable
                      ? "Connect to OpenCode to load the answer styles this assistant supports."
                      : "This assistant does not expose separate answer styles right now, so OpenWork will use its built-in default."}
                  </div>
                }
              >
                <div class="grid gap-3 sm:grid-cols-2">
                  <For each={props.answerStyleOptions}>
                    {(option) => {
                      const active = () =>
                        optionActive(option, props.answerStyleId, props.answerStyleRawValue);

                      return (
                        <button
                          type="button"
                          class={`rounded-2xl border px-4 py-4 text-left transition-colors ${
                            active()
                              ? "border-blue-8 bg-blue-4/25 shadow-[0_1px_0_rgba(37,99,235,0.08)]"
                              : "border-gray-6/70 bg-gray-1/50 hover:border-gray-7 hover:bg-gray-1/70"
                          }`}
                          onClick={() => props.onSelectAnswerStyle(option.rawValue)}
                        >
                          <div class="flex items-start justify-between gap-3">
                            <div>
                              <div class="text-sm font-semibold text-gray-12">{option.label}</div>
                              <div class="mt-1 text-sm text-gray-10">{option.description}</div>
                            </div>
                            <div
                              class={`mt-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full border px-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
                                active()
                                  ? "border-blue-8 bg-blue-5/40 text-blue-11"
                                  : "border-gray-6 text-gray-8"
                              }`}
                            >
                              {active() ? "On" : "Off"}
                            </div>
                          </div>

                          <Show when={option.rawValue}>
                            <div class="mt-3 text-[11px] text-gray-8">
                              Uses <span class="font-mono text-gray-9">{option.rawValue}</span> for this assistant.
                            </div>
                          </Show>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </section>

            <section class="rounded-[24px] border border-gray-6/70 bg-gray-1/45 p-5 space-y-3">
              <div class="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-9">More options</div>

              <div class="flex items-center justify-between gap-4 rounded-2xl border border-gray-6/70 bg-gray-1/55 px-4 py-3">
                <div>
                  <div class="text-sm font-medium text-gray-12">Show step-by-step reasoning</div>
                  <div class="mt-1 text-xs text-gray-9">
                    Helpful when you want extra visibility. {props.developerMode ? "Developer mode is on." : "Visible in Developer mode."}
                  </div>
                </div>
                <Button variant="outline" class="h-9 rounded-xl px-3 text-xs font-semibold" onClick={props.onToggleShowThinking}>
                  {props.showThinking ? "On" : "Off"}
                </Button>
              </div>

              <div class="flex items-center justify-between gap-4 rounded-2xl border border-gray-6/70 bg-gray-1/55 px-4 py-3">
                <div>
                  <div class="text-sm font-medium text-gray-12">Clean up long chats automatically</div>
                  <div class="mt-1 text-xs text-gray-9">
                    Keeps longer runs tidy by compacting context after they finish.
                  </div>
                </div>
                <Button
                  variant="outline"
                  class="h-9 rounded-xl px-3 text-xs font-semibold"
                  onClick={props.onToggleAutoCompactContext}
                >
                  {props.autoCompactContext ? "On" : "Off"}
                </Button>
              </div>
            </section>
          </div>

          <div class="flex justify-end border-t border-gray-6/60 px-6 py-4 sm:px-7">
            <Button variant="secondary" class="rounded-xl px-4" onClick={props.onClose}>
              Done
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}
