import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { FileText, RefreshCcw, Save, X } from "lucide-solid";

import Button from "../button";
import LiveMarkdownEditor from "../live-markdown-editor";
import type { OpenworkServerClient, OpenworkWorkspaceFileContent, OpenworkWorkspaceFileWriteResult } from "../../lib/openwork-server";
import { OpenworkServerError } from "../../lib/openwork-server";

export type ArtifactMarkdownEditorProps = {
  open: boolean;
  path: string | null;
  workspaceId: string | null;
  client: OpenworkServerClient | null;
  onClose: () => void;
  onToast?: (message: string) => void;
};

const isMarkdown = (value: string) => /\.(md|mdx|markdown)$/i.test(value);
const basename = (value: string) => value.split(/[/\\]/).filter(Boolean).pop() ?? value;

export default function ArtifactMarkdownEditor(props: ArtifactMarkdownEditorProps) {
  const [loading, setLoading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [original, setOriginal] = createSignal("");
  const [draft, setDraft] = createSignal("");
  const [loadedPath, setLoadedPath] = createSignal<string | null>(null);
  const [resolvedPath, setResolvedPath] = createSignal<string | null>(null);
  const [baseUpdatedAt, setBaseUpdatedAt] = createSignal<number | null>(null);

  const [confirmDiscardClose, setConfirmDiscardClose] = createSignal(false);
  const [confirmOverwrite, setConfirmOverwrite] = createSignal(false);

  const [pendingPath, setPendingPath] = createSignal<string | null>(null);
  const [pendingReason, setPendingReason] = createSignal<"switch" | null>(null);

  const path = createMemo(() => props.path?.trim() ?? "");
  const title = createMemo(() => (path() ? basename(path()) : "Artifact"));
  const dirty = createMemo(() => draft() !== original());
  const canWrite = createMemo(() => Boolean(props.client && props.workspaceId));
  const canSave = createMemo(() => dirty() && !saving() && canWrite());
  const writeDisabledReason = createMemo(() => {
    if (canWrite()) return null;
    return "Connect to an OpenWork server worker to edit files.";
  });

  const resetState = () => {
    setLoading(false);
    setSaving(false);
    setError(null);
    setOriginal("");
    setDraft("");
    setLoadedPath(null);
    setResolvedPath(null);
    setBaseUpdatedAt(null);
    setConfirmDiscardClose(false);
    setConfirmOverwrite(false);
    setPendingPath(null);
    setPendingReason(null);
  };

  const load = async (target: string) => {
    const client = props.client;
    const workspaceId = props.workspaceId;

    if (!client || !workspaceId) {
      setError(writeDisabledReason());
      return;
    }
    if (!target) {
      return;
    }
    if (!isMarkdown(target)) {
      setError("Only markdown files are supported.");
      return;
    }

    setLoading(true);
    setError(null);
    setResolvedPath(null);
    try {
      let result: OpenworkWorkspaceFileContent;
      let actualPath = target;
      try {
        result = (await client.readWorkspaceFile(workspaceId, target)) as OpenworkWorkspaceFileContent;
      } catch (err) {
        // Artifacts are frequently referenced as workspace-relative paths (e.g. `learned/foo.md`),
        // but on disk they may live under the OpenWork outbox dir: `.opencode/openwork/outbox/`.
        // If the first lookup fails, retry there.
        const candidateOutbox = `.opencode/openwork/outbox/${target}`.replace(/\/+/g, "/");
        const shouldTryOutbox =
          !(target.startsWith(".opencode/openwork/outbox/") || target.startsWith("./.opencode/openwork/outbox/")) &&
          err instanceof OpenworkServerError &&
          err.status === 404;

        if (!shouldTryOutbox) {
          throw err;
        }

        actualPath = candidateOutbox;
        try {
          result = (await client.readWorkspaceFile(workspaceId, actualPath)) as OpenworkWorkspaceFileContent;
        } catch (second) {
          if (second instanceof OpenworkServerError && second.status === 404) {
            throw new OpenworkServerError(404, "file_not_found", "File not found (workspace root or outbox).");
          }
          throw second;
        }
      }

      setOriginal(result.content ?? "");
      setDraft(result.content ?? "");
      setLoadedPath(target);
      setResolvedPath(actualPath);
      setBaseUpdatedAt(typeof result.updatedAt === "number" ? result.updatedAt : null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load file";
      setError(message);
      setLoadedPath(target);
    } finally {
      setLoading(false);
    }
  };

  const save = async (options?: { force?: boolean }) => {
    const client = props.client;
    const workspaceId = props.workspaceId;
    const target = resolvedPath() ?? path();
    if (!client || !workspaceId || !target) {
      props.onToast?.("Cannot save: OpenWork server not connected");
      return;
    }
    if (!isMarkdown(target)) {
      props.onToast?.("Only markdown files are supported");
      return;
    }
    if (!dirty()) return;

    setSaving(true);
    setError(null);
    try {
      const result = (await client.writeWorkspaceFile(workspaceId, {
        path: target,
        content: draft(),
        baseUpdatedAt: baseUpdatedAt(),
        force: options?.force ?? false,
      })) as OpenworkWorkspaceFileWriteResult;

      setOriginal(draft());
      setBaseUpdatedAt(typeof result.updatedAt === "number" ? result.updatedAt : null);

      if (pendingPath() && pendingReason() === "switch") {
        const next = pendingPath();
        setPendingPath(null);
        setPendingReason(null);
        if (next) void load(next);
      }
    } catch (err) {
      if (err instanceof OpenworkServerError && err.status === 409) {
        setConfirmOverwrite(true);
        return;
      }
      const message = err instanceof Error ? err.message : "Failed to save";
      setError(message);
      props.onToast?.(message);
    } finally {
      setSaving(false);
    }
  };

  const requestClose = () => {
    if (!dirty()) {
      resetState();
      props.onClose();
      return;
    }
    setConfirmDiscardClose(true);
  };

  const requestReload = () => {
    const target = path();
    if (!target) return;
    if (!dirty()) {
      void load(target);
      return;
    }
    // Reload is destructive; reuse the close-discard banner semantics.
    setError("Discard changes to reload from disk (close and reopen), or save first.");
  };

  createEffect(() => {
    if (!props.open) {
      resetState();
      return;
    }

    const target = path();
    if (!target || loading() || pendingReason() === "switch") return;

    const active = loadedPath();
    if (!active) {
      void load(target);
      return;
    }
    if (target === active) return;

    if (!dirty()) {
      void load(target);
      return;
    }

    setPendingPath(target);
    setPendingReason("switch");
  });

  createEffect(() => {
    if (!props.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (canSave()) void save();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  return (
    <Show when={props.open}>
      <div class="flex flex-col h-full min-h-0">
        <div class="h-14 px-4 border-b border-dls-border flex items-center justify-between bg-dls-sidebar">
          <div class="flex items-center gap-2 min-w-0">
            <FileText size={16} class="text-dls-secondary shrink-0" />
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <div class="text-sm font-semibold text-dls-text truncate">{title()}</div>
                <Show when={dirty()}>
                  <span class="text-[10px] px-2 py-0.5 rounded-full border border-amber-7/40 bg-amber-2/30 text-amber-11">
                    Unsaved
                  </span>
                </Show>
              </div>
              <div class="text-[11px] text-dls-secondary font-mono truncate" title={path()}>
                {path()}
              </div>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <Button
              variant="outline"
              class="text-xs h-9 py-0 px-3"
              onClick={requestReload}
              disabled={loading() || saving()}
              title="Reload from disk"
            >
              <RefreshCcw size={14} class={loading() ? "animate-spin" : ""} />
              Reload
            </Button>
            <Button
              class="text-xs h-9 py-0 px-3"
              onClick={() => void save()}
              disabled={!canSave()}
              title={writeDisabledReason() ?? "Save (Ctrl/Cmd+S)"}
            >
              <Save size={14} class={saving() ? "animate-pulse" : ""} />
              {saving() ? "Saving..." : "Save"}
            </Button>
            <button
              type="button"
              class="p-2 rounded-lg text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
              onClick={requestClose}
              title="Close"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <Show when={writeDisabledReason()}>
          {(reason) => (
            <div class="shrink-0 px-4 py-2 border-b border-dls-border text-[11px] text-dls-secondary">
              {reason()}
            </div>
          )}
        </Show>

        <Show when={error()}>
          {(message) => (
            <div class="shrink-0 px-4 py-2 border-b border-dls-border bg-red-2/20 text-red-11 text-xs">
              {message()}
            </div>
          )}
        </Show>

        <Show when={confirmOverwrite()}>
          <div class="shrink-0 px-4 py-2 border-b border-dls-border bg-amber-2/20 text-amber-11 text-xs flex items-center justify-between gap-3">
            <div class="min-w-0">File changed since load. Overwrite anyway?</div>
            <div class="shrink-0 flex items-center gap-2">
              <Button variant="outline" class="text-xs h-8 py-0 px-3" onClick={() => setConfirmOverwrite(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                class="text-xs h-8 py-0 px-3"
                onClick={() => {
                  setConfirmOverwrite(false);
                  void save({ force: true });
                }}
              >
                Overwrite
              </Button>
            </div>
          </div>
        </Show>

        <Show when={confirmDiscardClose()}>
          <div class="shrink-0 px-4 py-2 border-b border-dls-border bg-amber-2/20 text-amber-11 text-xs flex items-center justify-between gap-3">
            <div class="min-w-0">Discard unsaved changes and close?</div>
            <div class="shrink-0 flex items-center gap-2">
              <Button variant="outline" class="text-xs h-8 py-0 px-3" onClick={() => setConfirmDiscardClose(false)}>
                Keep
              </Button>
              <Button
                variant="secondary"
                class="text-xs h-8 py-0 px-3"
                onClick={() => {
                  setConfirmDiscardClose(false);
                  resetState();
                  props.onClose();
                }}
              >
                Discard
              </Button>
            </div>
          </div>
        </Show>

        <Show when={pendingPath() && pendingReason() === "switch"}>
          <div class="shrink-0 px-4 py-2 border-b border-dls-border bg-amber-2/20 text-amber-11 text-xs flex items-center justify-between gap-3">
            <div class="min-w-0 truncate" title={pendingPath() ?? ""}>
              Switch to {pendingPath()}
            </div>
            <div class="shrink-0 flex items-center gap-2">
              <Button
                variant="outline"
                class="text-xs h-8 py-0 px-3"
                onClick={() => {
                  setPendingPath(null);
                  setPendingReason(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="secondary"
                class="text-xs h-8 py-0 px-3"
                onClick={() => {
                  const next = pendingPath();
                  setPendingPath(null);
                  setPendingReason(null);
                  setOriginal("");
                  setDraft("");
                  if (next) void load(next);
                }}
              >
                Discard & switch
              </Button>
              <Button class="text-xs h-8 py-0 px-3" onClick={() => void save()} disabled={!canSave()}>
                Save & switch
              </Button>
            </div>
          </div>
        </Show>

        <div class="flex-1 min-h-0 overflow-hidden">
          <LiveMarkdownEditor
            value={draft()}
            onChange={setDraft}
            placeholder=""
            ariaLabel="Artifact editor"
            class="h-full"
            autofocus
          />
        </div>
      </div>
    </Show>
  );
}
