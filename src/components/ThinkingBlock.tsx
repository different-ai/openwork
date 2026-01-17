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
          class="flex items-center gap-2 text-xs font-medium text-zinc-500 hover:text-zinc-200 transition-colors py-1 px-2 rounded-lg hover:bg-zinc-900/40"
        >
          <div class="p-1 rounded bg-zinc-900 border border-zinc-800 text-zinc-500">
            <Zap size={12} />
          </div>
          <span class="truncate">{activeStep()?.text ?? "Working…"}</span>
          <ChevronRight
            size={12}
            class={`text-zinc-600 transition-transform ${expanded() ? "rotate-90" : ""}`}
          />
        </button>

        <Show when={expanded()}>
          <div class="mt-2 ml-2 pl-4 border-l border-zinc-800 space-y-2 animate-in slide-in-from-top-1 duration-150">
            <For each={props.steps}>
              {(step) => (
                <div class="flex items-start gap-3 text-xs text-zinc-400 font-mono">
                  <div class="mt-0.5">
                    <Show
                      when={step.status === "completed"}
                      fallback={
                        <Show
                          when={step.status === "running"}
                          fallback={
                            <Show
                              when={step.status === "error"}
                              fallback={<Circle size={12} class="text-zinc-700" />}
                            >
                              <X size={12} class="text-red-400" />
                            </Show>
                          }
                        >
                          <RefreshCcw size={12} class="text-blue-400 animate-spin" />
                        </Show>
                      }
                    >
                      <CheckCircle2 size={12} class="text-emerald-500" />
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
