import { For, Show, createMemo, createSignal } from "solid-js";
import { FileText } from "lucide-solid";

export type TouchedFilesPanelProps = {
  files: string[];
  workspaceRoot?: string;
  onFileClick?: (path: string) => void;
  maxPreview?: number;
  id?: string;
};

const normalizePath = (value: string) => value.trim().replace(/[\\/]+/g, "/");
const splitPathSegments = (value: string) => value.split(/[/\\]/).filter(Boolean);

const toWorkspaceRelative = (file: string, root?: string) => {
  const normalizedRoot = (root ?? "").trim().replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  if (!normalizedRoot) return file;

  const normalizedFile = file.replace(/[\\/]+/g, "/");
  const rootKey = normalizedRoot.toLowerCase();
  const fileKey = normalizedFile.toLowerCase();

  if (fileKey === rootKey) return normalizedFile.split("/").pop() ?? normalizedFile;
  if (fileKey.startsWith(`${rootKey}/`)) return normalizedFile.slice(normalizedRoot.length + 1);
  return normalizedFile;
};

const getBasename = (value: string) => {
  const segments = splitPathSegments(value);
  return segments[segments.length - 1] ?? value;
};

const getDirname = (value: string) => {
  const segments = splitPathSegments(value);
  if (segments.length <= 1) return "";
  return segments.slice(0, -1).join("/");
};

const isMarkdown = (value: string) => /\.(md|mdx|markdown)$/i.test(value);

export default function TouchedFilesPanel(props: TouchedFilesPanelProps) {
  const [showAll, setShowAll] = createSignal(false);
  const maxPreview = createMemo(() => {
    const raw = props.maxPreview ?? 6;
    if (!Number.isFinite(raw)) return 6;
    return Math.min(12, Math.max(3, Math.floor(raw)));
  });

  const normalizedFiles = createMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();

    for (const entry of props.files ?? []) {
      const normalized = normalizePath(String(entry ?? ""));
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
      if (out.length >= 48) break;
    }

    return out;
  });

  const visibleFiles = createMemo(() => {
    const list = normalizedFiles();
    return showAll() ? list : list.slice(0, maxPreview());
  });

  const hiddenCount = createMemo(() => {
    const total = normalizedFiles().length;
    const shown = visibleFiles().length;
    return Math.max(0, total - shown);
  });

  const canOpen = createMemo(() => typeof props.onFileClick === "function");
  const prettyPath = (file: string) => toWorkspaceRelative(file, props.workspaceRoot);

  return (
    <div id={props.id} class="rounded-xl border border-dls-border bg-dls-hover px-3 py-2.5">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <FileText size={14} class="text-dls-secondary" />
          <div class="min-w-0">
            <div class="text-[11px] font-bold tracking-tight text-dls-secondary uppercase">
              Touched files
            </div>
          </div>
        </div>
        <Show when={normalizedFiles().length > 0}>
          <div class="text-[11px] text-dls-secondary font-mono">{normalizedFiles().length}</div>
        </Show>
      </div>

      <div class="mt-2 space-y-1">
        <Show
          when={visibleFiles().length > 0}
          fallback={<div class="text-xs text-dls-secondary px-1 py-1">None yet.</div>}
        >
          <For each={visibleFiles()}>
            {(file) => {
              const display = () => prettyPath(file);
              const base = () => getBasename(display());
              const dir = () => getDirname(display());
              const md = () => isMarkdown(base());
              return (
                <button
                  type="button"
                  class={`w-full flex items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                    canOpen() ? "hover:bg-dls-active" : "cursor-default"
                  }`}
                  onClick={() => props.onFileClick?.(file)}
                  disabled={!canOpen()}
                  title={display()}
                  aria-label={canOpen() ? `Open ${display()}` : display()}
                >
                  <div class="mt-0.5 shrink-0">
                    <span class="h-1.5 w-1.5 rounded-full bg-dls-border inline-block" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <div class="truncate text-xs font-medium text-dls-text">{base()}</div>
                      <Show when={md()}>
                        <span class="shrink-0 rounded-md border border-dls-border bg-dls-surface px-1.5 py-0.5 text-[10px] font-mono text-dls-secondary">
                          MD
                        </span>
                      </Show>
                    </div>
                    <Show when={dir()}>
                      <div class="truncate text-[11px] text-dls-secondary">{dir()}</div>
                    </Show>
                  </div>
                </button>
              );
            }}
          </For>
        </Show>

        <Show when={hiddenCount() > 0}>
          <button
            type="button"
            class="w-full mt-1 rounded-lg px-2 py-1.5 text-xs text-dls-secondary hover:text-dls-text hover:bg-dls-active transition-colors"
            onClick={() => setShowAll((prev) => !prev)}
          >
            {showAll() ? "Show fewer" : `Show ${hiddenCount()} more`}
          </button>
        </Show>
      </div>
    </div>
  );
}
