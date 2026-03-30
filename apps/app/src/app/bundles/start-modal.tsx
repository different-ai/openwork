import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { FolderPlus, Loader2, Rocket, X } from "lucide-solid";

import Button from "../components/button";

export default function BundleStartModal(props: {
  open: boolean;
  templateName: string;
  description?: string | null;
  items?: string[];
  busy?: boolean;
  onClose: () => void;
  onPickFolder: () => Promise<string | null>;
  onConfirm: (folder: string | null) => void | Promise<void>;
}) {
  let pickFolderRef: HTMLButtonElement | undefined;
  const [selectedFolder, setSelectedFolder] = createSignal<string | null>(null);
  const [pickingFolder, setPickingFolder] = createSignal(false);

  createEffect(() => {
    if (!props.open) return;
    setSelectedFolder(null);
    requestAnimationFrame(() => pickFolderRef?.focus());
  });

  createEffect(() => {
    if (!props.open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (props.busy) return;
      props.onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  const visibleItems = createMemo(() => (props.items ?? []).filter(Boolean).slice(0, 4));
  const hiddenItemCount = createMemo(() => Math.max(0, (props.items ?? []).filter(Boolean).length - visibleItems().length));
  const canSubmit = createMemo(() => Boolean(selectedFolder()?.trim()) && !props.busy && !pickingFolder());

  const handlePickFolder = async () => {
    if (pickingFolder() || props.busy) return;
    setPickingFolder(true);
    try {
      const next = await props.onPickFolder();
      if (next) setSelectedFolder(next);
    } finally {
      setPickingFolder(false);
    }
  };

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-gray-1/70 p-4 backdrop-blur-sm">
        <div class="w-full max-w-xl overflow-hidden rounded-[28px] border border-dls-border bg-dls-surface shadow-2xl animate-in fade-in zoom-in-95 duration-200">
          <div class="border-b border-dls-border px-6 py-5 bg-dls-surface">
            <div class="flex items-start justify-between gap-4">
              <div class="flex min-w-0 items-start gap-3">
                <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-dls-accent/10 text-dls-accent">
                  <Rocket size={20} />
                </div>
                <div class="min-w-0">
                  <h3 class="truncate text-[18px] font-semibold text-dls-text">Start with {props.templateName}</h3>
                  <p class="mt-1 text-sm leading-relaxed text-dls-secondary">
                    {props.description?.trim() || "Pick a folder and OpenWork will create a workspace from this template."}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={props.onClose}
                disabled={Boolean(props.busy)}
                class="rounded-full p-1 text-dls-secondary transition hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <Show when={visibleItems().length > 0}>
              <div class="mt-4 flex flex-wrap gap-2">
                <For each={visibleItems()}>
                  {(item) => (
                    <span class="rounded-full border border-dls-border bg-dls-hover px-3 py-1 text-xs font-medium text-dls-text">
                      {item}
                    </span>
                  )}
                </For>
                <Show when={hiddenItemCount() > 0}>
                  <span class="rounded-full border border-dls-border bg-dls-hover px-3 py-1 text-xs font-medium text-dls-text">
                    +{hiddenItemCount()} more
                  </span>
                </Show>
              </div>
            </Show>
          </div>

          <div class="space-y-4 px-6 py-6">
            <div class="rounded-2xl border border-dls-border bg-dls-sidebar px-5 py-4">
              <div class="text-[15px] font-semibold text-dls-text">Workspace folder</div>
              <p class="mt-1 text-sm text-dls-secondary">
                Choose where this template should live. OpenWork will create the workspace and bring in the template automatically.
              </p>
              <div class="mt-4 rounded-xl border border-dls-border bg-dls-surface px-4 py-3 text-sm text-dls-text">
                <Show when={selectedFolder()?.trim()} fallback={<span class="text-dls-secondary">No folder selected yet.</span>}>
                  <span class="font-mono text-xs break-all">{selectedFolder()}</span>
                </Show>
              </div>
              <div class="mt-4">
                <button
                  type="button"
                  ref={pickFolderRef}
                  onClick={handlePickFolder}
                  disabled={pickingFolder() || Boolean(props.busy)}
                  class="inline-flex items-center gap-2 rounded-full border border-dls-border bg-dls-surface px-4 py-2 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover disabled:cursor-wait disabled:opacity-70"
                >
                  <Show when={pickingFolder()} fallback={<FolderPlus size={14} />}>
                    <Loader2 size={14} class="animate-spin" />
                  </Show>
                  {selectedFolder()?.trim() ? "Change folder" : "Select folder"}
                </button>
              </div>
            </div>

            <div class="flex items-center justify-end gap-3 border-t border-dls-border pt-4">
              <Button variant="ghost" onClick={props.onClose} disabled={Boolean(props.busy)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => void props.onConfirm(selectedFolder())}
                disabled={!canSubmit()}
              >
                <Show when={props.busy} fallback="Create workspace">
                  <span class="inline-flex items-center gap-2">
                    <Loader2 size={16} class="animate-spin" />
                    Starting template...
                  </span>
                </Show>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
