import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { Download, Inbox, RefreshCw, UploadCloud } from "lucide-solid";

import type { OpenworkInboxItem, OpenworkServerClient } from "../../lib/openwork-server";
import { formatBytes, formatRelativeTime } from "../../utils";

export type InboxPanelProps = {
  id?: string;
  client: OpenworkServerClient | null;
  workspaceId: string | null;
  onToast?: (message: string) => void;
  maxPreview?: number;
};

const INBOX_PREFIX = ".opencode/openwork/inbox/";

function safeName(item: OpenworkInboxItem): string {
  return String(item.name ?? item.path ?? "file").trim() || "file";
}

function safeRelPath(item: OpenworkInboxItem): string {
  const raw = String(item.path ?? item.name ?? "").trim();
  if (!raw) return "";
  return raw.replace(/^\/+/, "");
}

function toInboxWorkspacePath(item: OpenworkInboxItem): string {
  const rel = safeRelPath(item);
  return rel ? `${INBOX_PREFIX}${rel}` : INBOX_PREFIX;
}

export default function InboxPanel(props: InboxPanelProps) {
  const [items, setItems] = createSignal<OpenworkInboxItem[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [uploading, setUploading] = createSignal(false);
  const [dragOver, setDragOver] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  let fileInputRef: HTMLInputElement | undefined;

  const maxPreview = createMemo(() => {
    const raw = props.maxPreview ?? 6;
    if (!Number.isFinite(raw)) return 6;
    return Math.min(12, Math.max(3, Math.floor(raw)));
  });

  const connected = createMemo(() => Boolean(props.client && (props.workspaceId ?? "").trim()));
  const helperText = "Share files with your remote worker.";

  const visibleItems = createMemo(() => (items() ?? []).slice(0, maxPreview()));
  const hiddenCount = createMemo(() => Math.max(0, (items() ?? []).length - visibleItems().length));

  const toast = (message: string) => {
    props.onToast?.(message);
  };

  const refresh = async () => {
    const client = props.client;
    const workspaceId = (props.workspaceId ?? "").trim();
    if (!client || !workspaceId) {
      setItems([]);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await client.listInbox(workspaceId);
      setItems(result.items ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load inbox";
      setError(message);
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  const uploadFiles = async (files: File[]) => {
    const client = props.client;
    const workspaceId = (props.workspaceId ?? "").trim();
    if (!client || !workspaceId) {
      toast("Connect to a worker to upload inbox files.");
      return;
    }
    if (!files.length) return;

    setUploading(true);
    setError(null);
    try {
      const label = files.length === 1 ? files[0]?.name ?? "file" : `${files.length} files`;
      toast(`Uploading ${label}...`);
      for (const file of files) {
        await client.uploadInbox(workspaceId, file);
      }
      toast("Uploaded to worker inbox.");
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Inbox upload failed";
      setError(message);
      toast(message);
    } finally {
      setUploading(false);
    }
  };

  const copyPath = async (item: OpenworkInboxItem) => {
    const path = toInboxWorkspacePath(item);
    try {
      await navigator.clipboard.writeText(path);
      toast(`Copied: ${path}`);
    } catch {
      toast("Copy failed. Your browser may block clipboard access.");
    }
  };

  const downloadItem = async (item: OpenworkInboxItem) => {
    const client = props.client;
    const workspaceId = (props.workspaceId ?? "").trim();
    if (!client || !workspaceId) {
      toast("Connect to a worker to download inbox files.");
      return;
    }
    const id = String(item.id ?? "").trim();
    if (!id) {
      toast("Missing inbox item id.");
      return;
    }

    try {
      const result = await client.downloadInboxItem(workspaceId, id);
      const blob = new Blob([result.data], { type: result.contentType ?? "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename ?? safeName(item);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Download failed";
      toast(message);
    }
  };

  createEffect(() => {
    // Refresh when switching workers.
    void props.workspaceId;
    void props.client;
    void refresh();
  });

  return (
    <div id={props.id} class="rounded-xl border border-dls-border bg-dls-hover px-3 py-2.5">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <Inbox size={14} class="text-dls-secondary" />
          <div class="min-w-0">
            <div class="text-[11px] font-bold tracking-tight text-dls-secondary uppercase">Inbox</div>
          </div>
        </div>
        <div class="flex items-center gap-1.5">
          <Show when={(items() ?? []).length > 0}>
            <div class="text-[11px] text-dls-secondary font-mono">{(items() ?? []).length}</div>
          </Show>
          <button
            type="button"
            class="rounded-md p-1 text-dls-secondary hover:text-dls-text hover:bg-dls-active transition-colors"
            onClick={() => void refresh()}
            title="Refresh inbox"
            aria-label="Refresh inbox"
            disabled={!connected() || loading()}
          >
            <RefreshCw size={14} class={loading() ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      <div class="mt-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          class="hidden"
          onChange={(event: Event) => {
            const target = event.currentTarget as HTMLInputElement;
            const files = Array.from(target.files ?? []);
            if (files.length) void uploadFiles(files);
            target.value = "";
          }}
        />

        <button
          type="button"
          class={`w-full rounded-lg border border-dls-border bg-dls-surface px-3 py-2 text-left transition-colors ${
            dragOver() ? "bg-dls-active" : "hover:bg-dls-active"
          } ${!connected() ? "opacity-70" : ""}`}
          onClick={() => fileInputRef?.click()}
          onDragOver={(event: DragEvent) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={(event: DragEvent) => {
            event.preventDefault();
            setDragOver(false);
          }}
          onDrop={(event: DragEvent) => {
            event.preventDefault();
            setDragOver(false);
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (files.length) void uploadFiles(files);
          }}
          disabled={uploading()}
          title={connected() ? "Drop files here to upload" : "Connect to a worker to upload"}
        >
          <div class="flex items-start gap-2">
            <UploadCloud size={16} class="mt-0.5 text-dls-secondary" />
            <div class="min-w-0 flex-1">
              <div class="text-xs font-medium text-dls-text">
                {uploading() ? "Uploading..." : "Drop files or click to upload"}
              </div>
              <div class="mt-0.5 text-[11px] text-dls-secondary">{helperText}</div>
            </div>
          </div>
        </button>
      </div>

      <div class="mt-2 space-y-1">
        <Show when={error()}>
          <div class="text-xs text-red-11 px-1 py-1">{error()}</div>
        </Show>

        <Show
          when={visibleItems().length > 0}
          fallback={
            <div class="text-xs text-dls-secondary px-1 py-1">
              <Show when={connected()} fallback={"Connect to see inbox files."}>
                No inbox files yet.
              </Show>
            </div>
          }
        >
          <For each={visibleItems()}>
            {(item) => {
              const name = () => safeName(item);
              const rel = () => safeRelPath(item);
              const bytes = () => (typeof item.size === "number" ? item.size : null);
              const updatedAt = () => (typeof item.updatedAt === "number" ? item.updatedAt : null);

              return (
                <div class="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-dls-active">
                  <button
                    type="button"
                    class="min-w-0 flex-1 text-left"
                    onClick={() => void copyPath(item)}
                    title={rel() ? `Copy ${INBOX_PREFIX}${rel()}` : "Copy inbox path"}
                    aria-label={rel() ? `Copy ${INBOX_PREFIX}${rel()}` : "Copy inbox path"}
                    disabled={!connected()}
                  >
                    <div class="truncate text-xs font-medium text-dls-text">{name()}</div>
                    <div class="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-dls-secondary">
                      <Show when={bytes() != null}>
                        <span class="font-mono">{formatBytes(bytes() as number)}</span>
                      </Show>
                      <Show when={updatedAt() != null}>
                        <span>{formatRelativeTime(updatedAt() as number)}</span>
                      </Show>
                      <Show when={rel()}>
                        <span class="min-w-0 truncate font-mono">{rel()}</span>
                      </Show>
                    </div>
                  </button>

                  <button
                    type="button"
                    class="shrink-0 rounded-md p-1 text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
                    onClick={() => void downloadItem(item)}
                    title="Download"
                    aria-label="Download"
                    disabled={!connected()}
                  >
                    <Download size={14} />
                  </button>
                </div>
              );
            }}
          </For>
        </Show>

        <Show when={hiddenCount() > 0}>
          <div class="text-[11px] text-dls-secondary px-1 py-1">Showing first {maxPreview()}.</div>
        </Show>
      </div>
    </div>
  );
}
