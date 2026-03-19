import { For, Show, createMemo, createSignal } from "solid-js";
import { Paperclip } from "lucide-solid";

export type ArtifactsPanelProps = {
  files: string[];
  workspaceRoot?: string;
  onRevealArtifact?: (path: string) => void;
  onOpenInObsidian?: (path: string) => void;
  obsidianAvailable?: boolean;
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
const isImage = (value: string) => /\.(png|jpe?g|gif|webp|svg)$/i.test(value);

type ArtifactKind = "markdown" | "image";

const artifactKind = (value: string): ArtifactKind | null => {
  if (isMarkdown(value)) return "markdown";
  if (isImage(value)) return "image";
  return null;
};

export default function ArtifactsPanel(props: ArtifactsPanelProps) {
  const [showAll, setShowAll] = createSignal(false);
  const maxPreview = createMemo(() => {
    const raw = props.maxPreview ?? 6;
    if (!Number.isFinite(raw)) return 6;
    return Math.min(12, Math.max(3, Math.floor(raw)));
  });

  const normalizedArtifacts = createMemo(() => {
    const out: Array<{ path: string; kind: ArtifactKind }> = [];
    const seen = new Set<string>();

    for (const entry of props.files ?? []) {
      const normalized = normalizePath(String(entry ?? ""));
      if (!normalized) continue;
      const base = getBasename(normalized);
      const kind = artifactKind(base);
      if (!kind) continue;

      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path: normalized, kind });
      if (out.length >= 48) break;
    }

    return out;
  });

  const visibleArtifacts = createMemo(() => {
    const list = normalizedArtifacts();
    return showAll() ? list : list.slice(0, maxPreview());
  });

  const hiddenCount = createMemo(() => {
    const total = normalizedArtifacts().length;
    const shown = visibleArtifacts().length;
    return Math.max(0, total - shown);
  });

  const canRevealArtifact = createMemo(() => typeof props.onRevealArtifact === "function");
  const canOpenObsidian = createMemo(
    () => Boolean(props.obsidianAvailable) && typeof props.onOpenInObsidian === "function",
  );
  const prettyPath = (file: string) => toWorkspaceRelative(file, props.workspaceRoot);

  return (
    <div id={props.id}>
      <div class="flex items-center justify-between px-2 mb-3">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-gray-10">Artifacts</span>
        <Show when={normalizedArtifacts().length > 0}>
          <span class="text-[11px] font-medium bg-gray-4/60 text-gray-10 px-1.5 rounded">
            {normalizedArtifacts().length}
          </span>
        </Show>
      </div>

      <div class="space-y-1">
        <Show
          when={visibleArtifacts().length > 0}
          fallback={<div class="text-xs text-gray-10 px-2 py-1">No artifacts yet.</div>}
        >
          <For each={visibleArtifacts()}>
            {(artifact) => {
              const display = () => prettyPath(artifact.path);
              const base = () => getBasename(display());
              const dir = () => getDirname(display());
              const md = () => artifact.kind === "markdown";
              const img = () => artifact.kind === "image";
              return (
                <div
                  class="group w-full flex items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors border border-transparent hover:bg-gray-2 hover:border-gray-6/80"
                  title={display()}
                >
                  <div class="mt-0.5 shrink-0">
                    <Paperclip size={12} class="text-gray-9" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <div class="truncate text-xs font-medium text-gray-11">{base()}</div>
                      <Show when={md()}>
                        <span class="shrink-0 rounded-md border border-gray-6 bg-gray-2 px-1.5 py-0.5 text-[10px] font-mono text-gray-10">
                          MD
                        </span>
                      </Show>
                      <Show when={img()}>
                        <span class="shrink-0 rounded-md border border-gray-6 bg-gray-2 px-1.5 py-0.5 text-[10px] font-mono text-gray-10">
                          IMG
                        </span>
                      </Show>
                    </div>
                    <Show when={dir()}>
                      <div class="truncate text-[11px] text-gray-9">{dir()}</div>
                    </Show>
                  </div>
                  <div class="shrink-0 flex items-center gap-1.5">
                    <Show when={md() && canOpenObsidian()}>
                      <button
                        type="button"
                        class="rounded-md border border-gray-6 bg-gray-2 px-1.5 py-0.5 text-[10px] font-medium text-gray-10 hover:text-gray-12 hover:border-gray-7 transition-colors"
                        onClick={() => props.onOpenInObsidian?.(artifact.path)}
                        title="Open in Obsidian"
                      >
                        Obsidian
                      </button>
                    </Show>
                    <Show when={canRevealArtifact()}>
                      <button
                        type="button"
                        class="rounded-md border border-gray-6 bg-gray-2 px-1.5 py-0.5 text-[10px] font-medium text-gray-10 hover:text-gray-12 hover:border-gray-7 transition-colors"
                        onClick={() => props.onRevealArtifact?.(artifact.path)}
                        title={img() ? "Reveal image in Finder" : "Reveal file in Finder"}
                      >
                        Reveal
                      </button>
                    </Show>
                  </div>
                </div>
              );
            }}
          </For>
        </Show>

        <Show when={hiddenCount() > 0}>
          <button
            type="button"
            class="w-full mt-1 rounded-lg px-2 py-1.5 text-xs text-gray-10 hover:text-gray-11 hover:bg-gray-3 transition-colors"
            onClick={() => setShowAll((prev) => !prev)}
          >
            {showAll() ? "Show fewer" : `Show ${hiddenCount()} more`}
          </button>
        </Show>
      </div>
    </div>
  );
}
