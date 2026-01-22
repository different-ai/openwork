import { For, Show, createMemo, createSignal } from "solid-js";

import { CheckCircle2, ChevronRight, Circle, RefreshCcw, X, Zap } from "lucide-solid";

export type ThinkingStep = {
  status: "pending" | "running" | "completed" | "error";
  text: string;
};

export default function ThinkingBlock(props: {
  steps: ThinkingStep[];
  maxWidthClass?: string;
}) {
  const [expanded, setExpanded] = createSignal(false);

  const activeStep = createMemo(() => {
    const steps = props.steps;
    return steps.find((s) => s.status === "running") ?? steps[steps.length - 1] ?? null;
  });

  return (
    <Show when={props.steps.length > 0}>
      <div class={props.maxWidthClass ?? "w-full max-w-[85%]"}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          class="flex items-center gap-2 text-xs font-medium text-gray-10 hover:text-gray-12 transition-colors py-1 px-2 rounded-lg hover:bg-gray-2/40"
        >
          <div class="p-1 rounded bg-gray-2 border border-gray-6 text-gray-10">
            <Zap size={12} />
          </div>
          <span class="truncate">{activeStep()?.text ?? "Working…"}</span>
          <ChevronRight
            size={12}
            class={`text-gray-7 transition-transform ${expanded() ? "rotate-90" : ""}`}
          />
        </button>

        <Show when={expanded()}>
          <div class="mt-2 ml-2 pl-4 border-l border-gray-6 space-y-2 animate-in slide-in-from-top-12 duration-150">
            <For each={props.steps}>
              {(step) => (
                <div class="flex items-start gap-3 text-xs text-gray-11 font-mono">
                  <div class="mt-0.5">
                    <Show
                      when={step.status === "completed"}
                      fallback={
                        <Show
                          when={step.status === "running"}
                          fallback={
                            <Show
                              when={step.status === "error"}
                              fallback={<Circle size={12} class="text-gray-8" />}
                            >
                              <X size={12} class="text-red-11" />
                            </Show>
                          }
                        >
                          <RefreshCcw size={12} class="text-blue-11 animate-spin" />
                        </Show>
                      }
                    >
                      <CheckCircle2 size={12} class="text-green-6" />
                    </Show>
                  </div>
                  <span class="leading-relaxed">{step.text}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}
