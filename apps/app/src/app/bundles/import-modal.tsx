import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { Boxes, ChevronDown, ChevronRight, Plus, Sparkles, X } from "lucide-solid";

import type { BundleWorkerOption } from "./types";

export default function BundleImportModal(props: {
  open: boolean;
  title: string;
  description: string;
  items: string[];
  workers: BundleWorkerOption[];
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onCreateNewWorker: () => void;
  onSelectWorker: (workspaceId: string) => void;
}) {
  const [showWorkers, setShowWorkers] = createSignal(false);

  createEffect(() => {
    if (!props.open) return;
    setShowWorkers(false);
  });

  createEffect(() => {
    if (!props.open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      props.onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  const visibleItems = createMemo(() => props.items.filter(Boolean).slice(0, 4));
  const hiddenItemCount = createMemo(() => Math.max(0, props.items.filter(Boolean).length - visibleItems().length));
  const busy = () => Boolean(props.busy);

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-gray-1/70 p-4 backdrop-blur-sm">
        <div class="w-full max-w-xl overflow-hidden rounded-2xl border border-gray-6 bg-gray-2 shadow-2xl">
          <div class="border-b border-gray-6 bg-gray-1 px-6 py-5">
            <div class="flex items-start justify-between gap-4">
              <div class="flex items-start gap-3">
                <div class="flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-9/15 text-indigo-11">
                  <Boxes size={20} />
                </div>
                <div>
                  <h3 class="text-lg font-semibold text-gray-12">{props.title}</h3>
                  <p class="mt-1 text-sm leading-relaxed text-gray-10">{props.description}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={props.onClose}
                disabled={busy()}
                class="rounded-full p-1 text-gray-10 transition hover:bg-gray-4 hover:text-gray-12 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <Show when={visibleItems().length > 0}>
              <div class="mt-4 flex flex-wrap gap-2">
                <For each={visibleItems()}>
                  {(item) => (
                    <span class="rounded-full border border-gray-6 bg-gray-3 px-3 py-1 text-xs font-medium text-gray-11">
                      {item}
                    </span>
                  )}
                </For>
                <Show when={hiddenItemCount() > 0}>
                  <span class="rounded-full border border-gray-6 bg-gray-3 px-3 py-1 text-xs font-medium text-gray-11">
                    +{hiddenItemCount()} more
                  </span>
                </Show>
              </div>
            </Show>
          </div>

          <div class="space-y-4 p-6">
            <Show when={props.error?.trim()}>
              <div class="rounded-xl border border-red-6 bg-red-2 px-4 py-3 text-sm text-red-11">{props.error}</div>
            </Show>

            <button
              type="button"
              onClick={props.onCreateNewWorker}
              disabled={busy()}
              class="flex w-full items-center justify-between rounded-2xl border border-indigo-7/30 bg-indigo-9/10 px-4 py-4 text-left transition hover:border-indigo-7/50 hover:bg-indigo-9/15 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <div class="flex items-start gap-3">
                <div class="mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-9/20 text-indigo-11">
                  <Plus size={18} />
                </div>
                <div>
                  <div class="text-sm font-semibold text-gray-12">Create new worker</div>
                  <div class="mt-1 text-sm text-gray-10">Open the existing new worker flow, then import this bundle into it.</div>
                </div>
              </div>
              <Sparkles size={18} class="text-indigo-11" />
            </button>

            <div class="rounded-2xl border border-gray-6 bg-gray-1/70">
              <button
                type="button"
                onClick={() => setShowWorkers((value) => !value)}
                disabled={busy()}
                class="flex w-full items-center justify-between gap-3 px-4 py-4 text-left transition hover:bg-gray-3/60 disabled:cursor-not-allowed disabled:opacity-60"
                aria-expanded={showWorkers()}
              >
                <div>
                  <div class="text-sm font-semibold text-gray-12">Add to existing worker</div>
                  <div class="mt-1 text-sm text-gray-10">Pick an existing worker and import this bundle there.</div>
                </div>
                <Show when={showWorkers()} fallback={<ChevronRight size={18} class="text-gray-10" />}>
                  <ChevronDown size={18} class="text-gray-10" />
                </Show>
              </button>

              <Show when={showWorkers()}>
                <div class="space-y-3 border-t border-gray-6 px-4 py-4">
                  <Show
                    when={props.workers.length > 0}
                    fallback={<div class="rounded-xl border border-dashed border-gray-6 px-4 py-5 text-sm text-gray-10">No configured workers are available yet. Create a new worker to import this bundle.</div>}
                  >
                    <For each={props.workers}>
                      {(worker) => {
                        const disabledReason = () => worker.disabledReason?.trim() ?? "";
                        const disabled = () => Boolean(disabledReason()) || busy();
                        return (
                          <button
                            type="button"
                            onClick={() => props.onSelectWorker(worker.id)}
                            disabled={disabled()}
                            class="w-full rounded-xl border border-gray-6 bg-gray-2 px-4 py-3 text-left transition hover:border-gray-7 hover:bg-gray-3 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <div class="flex items-start justify-between gap-3">
                              <div class="min-w-0 flex-1">
                                <div class="flex flex-wrap items-center gap-2">
                                  <span class="text-sm font-semibold text-gray-12">{worker.label}</span>
                                  <span class="rounded-full border border-gray-6 bg-gray-3 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-10">
                                    {worker.badge}
                                  </span>
                                  <Show when={worker.current}>
                                    <span class="rounded-full border border-emerald-7/40 bg-emerald-9/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-emerald-11">
                                      Current
                                    </span>
                                  </Show>
                                </div>
                                <div class="mt-1 truncate text-sm text-gray-10">{worker.detail}</div>
                                <Show when={disabledReason()}>
                                  <div class="mt-2 text-xs text-amber-11">{disabledReason()}</div>
                                </Show>
                              </div>
                              <ChevronRight size={18} class="mt-0.5 shrink-0 text-gray-10" />
                            </div>
                          </button>
                        );
                      }}
                    </For>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
