import { Show } from "solid-js";

import { CheckCircle2, Info, X } from "lucide-solid";

import Button from "./button";

export type StatusToastProps = {
  open: boolean;
  title: string;
  description?: string | null;
  tone?: "success" | "info";
  actionLabel?: string;
  onAction?: () => void;
  dismissLabel?: string;
  onDismiss: () => void;
};

export default function StatusToast(props: StatusToastProps) {
  const tone = () => props.tone ?? "info";

  return (
    <Show when={props.open}>
      <div class="w-full max-w-[24rem] overflow-hidden rounded-[1.4rem] border border-white/70 bg-white/92 shadow-[0_24px_60px_-28px_rgba(15,23,42,0.28)] backdrop-blur-xl">
        <div class="flex items-start gap-3 px-4 py-4">
          <div
            class={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border ${
              tone() === "success"
                ? "border-emerald-6/40 bg-emerald-4/80 text-emerald-11"
                : "border-sky-6/40 bg-sky-4/80 text-sky-11"
            }`.trim()}
          >
            <Show when={tone() === "success"} fallback={<Info size={18} />}>
              <CheckCircle2 size={18} />
            </Show>
          </div>

          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="text-sm font-semibold text-gray-12">{props.title}</div>
                <Show when={props.description?.trim()}>
                  <p class="mt-1 text-sm leading-relaxed text-gray-10">{props.description}</p>
                </Show>
              </div>

              <button
                type="button"
                onClick={props.onDismiss}
                class="rounded-full p-1 text-gray-9 transition hover:bg-gray-3 hover:text-gray-12"
                aria-label={props.dismissLabel ?? "Dismiss"}
              >
                <X size={16} />
              </button>
            </div>

            <Show when={props.actionLabel && props.onAction}>
              <div class="mt-3 flex items-center gap-2">
                <Button variant="primary" class="rounded-full px-3 py-1.5 text-xs" onClick={() => props.onAction?.()}>
                  {props.actionLabel}
                </Button>
                <Button variant="ghost" class="rounded-full px-3 py-1.5 text-xs" onClick={props.onDismiss}>
                  {props.dismissLabel ?? "Dismiss"}
                </Button>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
