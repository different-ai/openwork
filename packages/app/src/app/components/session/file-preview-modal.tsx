import { For, Show, createMemo, createSignal } from "solid-js";
import { Copy, File, X } from "lucide-solid";

import Button from "../button";
import { formatBytes } from "../../utils";

export type FilePreviewModalProps = {
  open: boolean;
  path: string | null;
  content: string | null;
  size?: number | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onAddContext: (path: string, startLine?: number, endLine?: number) => void;
};

export default function FilePreviewModal(props: FilePreviewModalProps) {
  const [startLine, setStartLine] = createSignal("");
  const [endLine, setEndLine] = createSignal("");

  const lines = createMemo(() => (props.content ?? "").split(/\n/));
  const fileName = createMemo(() => props.path?.split(/[/\\]/).pop() ?? "File");

  const resetRange = () => {
    setStartLine("");
    setEndLine("");
  };

  const handleAddContext = () => {
    if (!props.path) return;
    const start = Number.parseInt(startLine(), 10);
    const end = Number.parseInt(endLine(), 10);
    const resolvedStart = Number.isFinite(start) && start > 0 ? start : undefined;
    const resolvedEnd = Number.isFinite(end) && end > 0 ? end : undefined;
    props.onAddContext(props.path, resolvedStart, resolvedEnd);
    resetRange();
  };

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto">
        <div class="bg-gray-2 border border-gray-6/70 w-full max-w-4xl rounded-2xl shadow-2xl overflow-hidden max-h-[calc(100vh-2rem)] flex flex-col">
          <div class="p-5 border-b border-gray-6/50 flex items-center justify-between gap-3">
            <div class="flex items-center gap-3 min-w-0">
              <div class="h-9 w-9 rounded-xl border border-gray-6 bg-gray-1 flex items-center justify-center">
                <File size={16} class="text-gray-10" />
              </div>
              <div class="min-w-0">
                <div class="text-sm font-semibold text-gray-12 truncate">{fileName()}</div>
                <div class="text-xs text-gray-9 truncate">{props.path}</div>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <Show when={props.path && props.content}>
                <Button
                  variant="ghost"
                  class="!p-2 rounded-full"
                  onClick={() => navigator.clipboard.writeText(props.content ?? "")}
                >
                  <Copy size={16} />
                </Button>
              </Show>
              <Button variant="ghost" class="!p-2 rounded-full" onClick={props.onClose}>
                <X size={16} />
              </Button>
            </div>
          </div>

          <div class="px-5 py-4 border-b border-gray-6/50 flex items-center gap-3 text-xs text-gray-9">
            <span>{props.size ? formatBytes(props.size) : ""}</span>
            <span>Lines: {lines().length}</span>
            <div class="ml-auto flex items-center gap-2">
              <input
                type="number"
                min="1"
                value={startLine()}
                onInput={(event) => setStartLine(event.currentTarget.value)}
                placeholder="Start line"
                class="w-24 rounded-lg border border-gray-6 bg-gray-1 px-2 py-1 text-xs text-gray-11"
              />
              <input
                type="number"
                min="1"
                value={endLine()}
                onInput={(event) => setEndLine(event.currentTarget.value)}
                placeholder="End line"
                class="w-24 rounded-lg border border-gray-6 bg-gray-1 px-2 py-1 text-xs text-gray-11"
              />
              <Button variant="outline" class="text-xs h-7" onClick={handleAddContext}>
                Add to context
              </Button>
            </div>
          </div>

          <div class="flex-1 overflow-auto p-5">
            <Show when={!props.loading} fallback={<div class="text-sm text-gray-9">Loading file...</div>}>
              <Show when={!props.error} fallback={<div class="text-sm text-red-11">{props.error}</div>}>
                <pre class="text-xs leading-6 text-gray-11">
                  <code>
                    <For each={lines()}>
                      {(line, index) => (
                        <div class="flex gap-4">
                          <span class="w-10 text-right text-gray-8 select-none">{index() + 1}</span>
                          <span class="whitespace-pre-wrap break-all text-gray-12">{line}</span>
                        </div>
                      )}
                    </For>
                  </code>
                </pre>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
