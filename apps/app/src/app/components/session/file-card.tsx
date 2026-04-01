import { Match, Show, Switch, createMemo, createResource } from "solid-js";
import {
  Archive,
  Database,
  File,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  ImageIcon,
  PlaySquare,
} from "lucide-solid";
import { usePlatform } from "../../context/platform";
import {
  getDefaultDesktopFileAssociation,
  resolvePrimaryLocalFile,
  runLocalFileAction,
} from "../../session/file-actions";
import {
  filePresentationForReference,
  type FileReferenceCard,
} from "../../session/file-presentations";
import { isTauriRuntime } from "../../utils";

type Props = {
  reference: FileReferenceCard;
  tone?: "light" | "dark";
  workspaceRoot?: string;
};

export default function FileCard(props: Props) {
  const platform = usePlatform();
  const tone = () => props.tone ?? "light";
  const workspaceRoot = () => props.workspaceRoot ?? "";
  const presentation = createMemo(() =>
    filePresentationForReference({
      path: props.reference.path,
      title: props.reference.title,
      detail: props.reference.detail,
      mime: props.reference.mime,
    }),
  );
  const [resolvedFile] = createResource(
    () => `${props.reference.path}\u0000${workspaceRoot()}`,
    async () => resolvePrimaryLocalFile(props.reference.path, workspaceRoot()),
  );
  const [defaultApp] = createResource(
    () => `${props.reference.path}\u0000${workspaceRoot()}`,
    async () => getDefaultDesktopFileAssociation(props.reference.path, workspaceRoot()),
  );

  const surfaceClass = () =>
    tone() === "dark"
      ? "border-gray-6 bg-gray-1/60"
      : "border-gray-6/70 bg-gray-2/30";
  const chipClass = () =>
    tone() === "dark"
      ? "bg-gray-12/10 text-gray-12/80"
      : "bg-gray-1/70 text-gray-9";
  const iconWrapClass = () =>
    tone() === "dark"
      ? "bg-gray-12/10 text-gray-12"
      : "bg-gray-1 text-gray-11";

  const openLabel = createMemo(() => {
    const app = defaultApp();
    if (app?.name?.trim()) {
      return `Open in ${app.name.replace(/\.app$/i, "")}`;
    }
    return "Open";
  });

  const canUseDesktopActions = createMemo(() =>
    Boolean(isTauriRuntime() && resolvedFile()),
  );

  const openReference = async () => {
    if (!resolvedFile()) return;
    if (!isTauriRuntime()) {
      platform.openLink(`file://${resolvedFile()}`);
      return;
    }

    const { openPath } = await import("@tauri-apps/plugin-opener");
    await runLocalFileAction({
      file: resolvedFile()!,
      workspaceRoot: workspaceRoot(),
      action: async (candidate) => {
        await openPath(candidate);
      },
    });
  };

  const revealReference = async () => {
    if (!resolvedFile() || !isTauriRuntime()) return;
    const { openPath, revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await runLocalFileAction({
      file: resolvedFile()!,
      workspaceRoot: workspaceRoot(),
      action: async (candidate) => {
        await revealItemInDir(candidate).catch(() => openPath(candidate));
      },
    });
  };

  const FileGlyph = () => (
    <Switch fallback={<File size={16} />}>
      <Match when={presentation().category === "spreadsheet"}>
        <FileSpreadsheet size={16} />
      </Match>
      <Match when={presentation().category === "document"}>
        <FileText size={16} />
      </Match>
      <Match when={presentation().category === "image"}>
        <ImageIcon size={16} />
      </Match>
      <Match when={presentation().category === "code"}>
        <FileCode2 size={16} />
      </Match>
      <Match when={presentation().category === "archive"}>
        <Archive size={16} />
      </Match>
      <Match when={presentation().category === "media"}>
        <PlaySquare size={16} />
      </Match>
      <Match when={presentation().category === "data"}>
        <Database size={16} />
      </Match>
    </Switch>
  );

  return (
    <div class={`rounded-[22px] border px-4 py-4 shadow-[var(--dls-card-shadow)] ${surfaceClass()}`.trim()}>
      <div class="flex items-start gap-3">
        <div class={`mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${iconWrapClass()}`.trim()}>
          <FileGlyph />
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <div class="min-w-0 flex-1 text-[15px] font-medium text-gray-12 truncate">
              {presentation().title}
            </div>
            <div class={`max-w-[180px] rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${chipClass()}`.trim()}>
              {presentation().typeLabel}
            </div>
          </div>
          <Show when={presentation().detail}>
            <div class="mt-1 text-[12px] text-gray-9 truncate">{presentation().detail}</div>
          </Show>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="rounded-full bg-dls-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-[var(--dls-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!canUseDesktopActions()}
              onClick={() => {
                void openReference();
              }}
            >
              {openLabel()}
            </button>
            <Show when={canUseDesktopActions()}>
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-full border border-dls-border bg-dls-surface px-3 py-1.5 text-[12px] font-medium text-gray-11 transition-colors hover:bg-dls-hover hover:text-gray-12"
                onClick={() => {
                  void revealReference();
                }}
              >
                <FolderOpen size={12} />
                Reveal
              </button>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
