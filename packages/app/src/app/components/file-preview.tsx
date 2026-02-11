import { Show } from "solid-js";
import { X, AlertCircle, FileText } from "lucide-solid";
import type { FileReadResult } from "../lib/tauri";

interface FilePreviewProps {
  filePath: string;
  content: FileReadResult | null;
  loading: boolean;
  error?: string | null;
  onClose: () => void;
}

export default function FilePreview(props: FilePreviewProps) {
  const fileName = () => {
    const parts = props.filePath.split(/[\\/]/);
    return parts[parts.length - 1] || props.filePath;
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div class="h-full flex flex-col bg-dls-surface border border-dls-border rounded-lg overflow-hidden">
      <div class="flex items-center justify-between px-4 py-3 border-b border-dls-border bg-dls-hover">
        <div class="flex items-center gap-3 min-w-0">
          <FileText size={18} class="text-dls-secondary shrink-0" />
          <div class="min-w-0">
            <div class="text-sm font-medium truncate" title={props.filePath}>
              {fileName()}
            </div>
            <Show when={props.content}>
              {(data) => (
                <div class="text-xs text-dls-secondary">
                  {formatSize(data().size)}
                  {data().language && ` · ${data().language}`}
                </div>
              )}
            </Show>
          </div>
        </div>
        <button
          onClick={props.onClose}
          class="p-1 rounded-md text-dls-secondary hover:text-dls-text hover:bg-dls-active transition-colors"
        >
          <X size={18} />
        </button>
      </div>

      <div class="flex-1 overflow-auto">
        <Show when={props.loading}>
          <div class="h-full flex items-center justify-center text-dls-secondary">
            <div class="text-sm">Loading file...</div>
          </div>
        </Show>

        <Show when={!props.loading && props.error}>
          <div class="h-full flex flex-col items-center justify-center p-8 text-center">
            <AlertCircle size={48} class="text-red-11 mb-4" />
            <div class="text-red-11 font-medium mb-2">Failed to load file</div>
            <div class="text-sm text-dls-secondary max-w-md">{props.error}</div>
          </div>
        </Show>

        <Show when={!props.loading && !props.error && props.content}>
          {(data) => (
            <pre class="p-4 text-sm font-mono text-dls-text whitespace-pre-wrap break-all">
              {data().content}
            </pre>
          )}
        </Show>

        <Show when={!props.loading && !props.error && !props.content}>
          <div class="h-full flex items-center justify-center text-dls-secondary">
            <div class="text-sm">No preview available</div>
          </div>
        </Show>
      </div>
    </div>
  );
}
