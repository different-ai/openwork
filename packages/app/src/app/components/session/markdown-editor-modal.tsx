import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { marked } from "marked";
import { Eye, FileText, Pencil, RefreshCcw, Save, X } from "lucide-solid";

import Button from "../button";
import ConfirmModal from "../confirm-modal";
import type {
  OpenworkServerClient,
  OpenworkWorkspaceFileContent,
  OpenworkWorkspaceFileWriteResult,
} from "../../lib/openwork-server";
import { OpenworkServerError } from "../../lib/openwork-server";

type ViewMode = "edit" | "preview" | "split";

export type MarkdownEditorModalProps = {
  open: boolean;
  path: string | null;
  workspaceId: string | null;
  client: OpenworkServerClient | null;
  onClose: () => void;
  onToast?: (message: string) => void;
};

const isMarkdown = (value: string) => /\.(md|mdx|markdown)$/i.test(value);
const basename = (value: string) => value.split(/[/\\]/).filter(Boolean).pop() ?? value;
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const isSafeUrl = (url: string) => {
  const normalized = (url || "").trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("javascript:")) return false;
  if (normalized.startsWith("data:")) return normalized.startsWith("data:image/");
  return true;
};

function createMarkdownRenderer() {
  const renderer = new marked.Renderer();

  renderer.html = ({ text }) => escapeHtml(text);

  renderer.code = ({ text, lang }) => {
    const language = lang ? escapeHtml(lang) : "";
    return `
      <div class="rounded-xl border border-dls-border bg-dls-surface px-4 py-3 my-4">
        ${
          language
            ? `<div class="text-[10px] uppercase tracking-[0.2em] text-dls-secondary mb-2">${language}</div>`
            : ""
        }
        <pre class="overflow-x-auto whitespace-pre text-[13px] leading-relaxed font-mono"><code>${escapeHtml(
          text,
        )}</code></pre>
      </div>
    `;
  };

  renderer.codespan = ({ text }) => {
    return `<code class="rounded-md px-1.5 py-0.5 text-[13px] font-mono bg-dls-active text-dls-text">${escapeHtml(
      text,
    )}</code>`;
  };

  renderer.link = ({ href, title, text }) => {
    const safeHref = isSafeUrl(href ?? "") ? escapeHtml(href ?? "#") : "#";
    const safeTitle = title ? escapeHtml(title) : "";
    return `
      <a
        href="${safeHref}"
        target="_blank"
        rel="noopener noreferrer"
        class="underline underline-offset-2 text-dls-accent"
        ${safeTitle ? `title="${safeTitle}"` : ""}
      >
        ${text}
      </a>
    `;
  };

  renderer.image = ({ href, title, text }) => {
    const safeHref = isSafeUrl(href ?? "") ? escapeHtml(href ?? "") : "";
    const safeTitle = title ? escapeHtml(title) : "";
    return `
      <img
        src="${safeHref}"
        alt="${escapeHtml(text || "")}"
        ${safeTitle ? `title="${safeTitle}"` : ""}
        class="max-w-full h-auto rounded-lg my-4"
      />
    `;
  };

  return renderer;
}

function useThrottledValue(value: () => string, delayMs = 120) {
  const [state, setState] = createSignal(value());
  let timer: number | undefined;

  createEffect(() => {
    const next = value();
    if (!delayMs) {
      setState(next);
      return;
    }
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      setState(next);
      timer = undefined;
    }, delayMs);
  });

  onCleanup(() => {
    if (timer) window.clearTimeout(timer);
  });

  return state;
}

export default function MarkdownEditorModal(props: MarkdownEditorModalProps) {
  let textareaRef: HTMLTextAreaElement | undefined;

  const initialMode = () =>
    typeof window !== "undefined" && window.innerWidth >= 1024 ? ("split" as const) : ("edit" as const);
  const [mode, setMode] = createSignal<ViewMode>(initialMode());
  const [loading, setLoading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [original, setOriginal] = createSignal("");
  const [draft, setDraft] = createSignal("");
  const [baseUpdatedAt, setBaseUpdatedAt] = createSignal<number | null>(null);
  const [confirmCloseOpen, setConfirmCloseOpen] = createSignal(false);
  const [confirmOverwriteOpen, setConfirmOverwriteOpen] = createSignal(false);
  const [confirmReloadOpen, setConfirmReloadOpen] = createSignal(false);
  const [lastSaveLabel, setLastSaveLabel] = createSignal<string | null>(null);

  const path = createMemo(() => props.path?.trim() ?? "");
  const title = createMemo(() => (path() ? basename(path()) : "Markdown"));
  const dirty = createMemo(() => draft() !== original());
  const canWrite = createMemo(() => Boolean(props.client && props.workspaceId));
  const canSave = createMemo(() => dirty() && !saving() && canWrite());
  const writeDisabledReason = createMemo(() => {
    if (canWrite()) return null;
    return "Connect to an OpenWork server (or run in desktop local mode) to edit files.";
  });

  const showSplit = createMemo(() => mode() === "split");
  const showPreview = createMemo(() => mode() === "preview" || mode() === "split");
  const previewSource = useThrottledValue(() => (props.open && showPreview() ? draft() : ""), 120);
  const previewHtml = createMemo(() => {
    if (!showPreview()) return "";
    const text = previewSource();
    if (!text.trim()) return "";
    try {
      const renderer = createMarkdownRenderer();
      const result = marked.parse(text, { breaks: true, gfm: true, renderer, async: false });
      return typeof result === "string" ? result : "";
    } catch {
      return "";
    }
  });

  const load = async () => {
    const client = props.client;
    const workspaceId = props.workspaceId;
    const target = path();
    if (!client || !workspaceId) {
      setError(writeDisabledReason());
      return;
    }
    if (!target) return;
    if (!isMarkdown(target)) {
      setError("Only markdown files are supported.");
      return;
    }

    setLoading(true);
    setError(null);
    setLastSaveLabel(null);
    try {
      const result = (await client.readWorkspaceFile(
        workspaceId,
        target,
      )) as OpenworkWorkspaceFileContent;
      setOriginal(result.content ?? "");
      setDraft(result.content ?? "");
      setBaseUpdatedAt(typeof result.updatedAt === "number" ? result.updatedAt : null);
      requestAnimationFrame(() => textareaRef?.focus());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load file";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const save = async (options?: { force?: boolean }) => {
    const client = props.client;
    const workspaceId = props.workspaceId;
    const target = path();
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
    setLastSaveLabel(null);
    try {
      const result = (await client.writeWorkspaceFile(workspaceId, {
        path: target,
        content: draft(),
        baseUpdatedAt: baseUpdatedAt(),
        force: options?.force ?? false,
      })) as OpenworkWorkspaceFileWriteResult;
      setOriginal(draft());
      setBaseUpdatedAt(typeof result.updatedAt === "number" ? result.updatedAt : null);
      setLastSaveLabel("Saved");
      window.setTimeout(() => setLastSaveLabel(null), 1600);
    } catch (err) {
      if (err instanceof OpenworkServerError && err.status === 409) {
        setConfirmOverwriteOpen(true);
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
      props.onClose();
      return;
    }
    setConfirmCloseOpen(true);
  };

  createEffect(() => {
    const open = props.open;
    const target = path();
    const workspaceId = props.workspaceId;
    const client = props.client;

    if (!open) {
      setLoading(false);
      setSaving(false);
      setError(null);
      setOriginal("");
      setDraft("");
      setBaseUpdatedAt(null);
      setConfirmCloseOpen(false);
      setConfirmOverwriteOpen(false);
      setConfirmReloadOpen(false);
      setLastSaveLabel(null);
      return;
    }

    if (!target) return;
    workspaceId;
    client;
    void load();
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
      <div class="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-dls-surface border border-dls-border w-full max-w-6xl h-[85vh] rounded-2xl shadow-2xl overflow-hidden flex flex-col">
          <div class="shrink-0 px-5 py-4 border-b border-dls-border flex items-center gap-3">
            <div class="shrink-0 w-9 h-9 rounded-xl bg-dls-hover border border-dls-border flex items-center justify-center text-dls-secondary">
              <FileText size={16} />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <div class="text-sm font-semibold text-dls-text truncate">{title()}</div>
                <Show when={dirty()}>
                  <span class="text-[10px] px-2 py-0.5 rounded-full border border-amber-7/40 bg-amber-2/30 text-amber-11">
                    Unsaved
                  </span>
                </Show>
                <Show when={!dirty() && lastSaveLabel()}>
                  <span class="text-[10px] px-2 py-0.5 rounded-full border border-green-7/40 bg-green-2/30 text-green-11">
                    {lastSaveLabel()}
                  </span>
                </Show>
              </div>
              <div class="text-[11px] text-dls-secondary font-mono truncate" title={path()}>
                {path()}
              </div>
            </div>

            <div class="flex items-center gap-2">
              <div class="hidden lg:flex items-center gap-1 rounded-xl border border-dls-border bg-dls-hover p-1">
                <button
                  type="button"
                  class={`h-8 px-2.5 rounded-lg text-xs font-medium transition-colors ${
                    mode() === "edit" ? "bg-dls-surface text-dls-text" : "text-dls-secondary hover:text-dls-text"
                  }`}
                  onClick={() => setMode("edit")}
                >
                  <Pencil size={14} class="inline-block mr-1" />
                  Edit
                </button>
                <button
                  type="button"
                  class={`h-8 px-2.5 rounded-lg text-xs font-medium transition-colors ${
                    mode() === "preview" ? "bg-dls-surface text-dls-text" : "text-dls-secondary hover:text-dls-text"
                  }`}
                  onClick={() => setMode("preview")}
                >
                  <Eye size={14} class="inline-block mr-1" />
                  Preview
                </button>
                <button
                  type="button"
                  class={`h-8 px-2.5 rounded-lg text-xs font-medium transition-colors ${
                    mode() === "split" ? "bg-dls-surface text-dls-text" : "text-dls-secondary hover:text-dls-text"
                  }`}
                  onClick={() => setMode("split")}
                  disabled={typeof window !== "undefined" && window.innerWidth < 1024}
                  title={typeof window !== "undefined" && window.innerWidth < 1024 ? "Split view needs a wider window" : "Split"}
                >
                  Split
                </button>
              </div>

              <Button
                variant="outline"
                class="text-xs h-9 py-0 px-3"
                onClick={() => {
                  if (dirty()) {
                    setConfirmReloadOpen(true);
                    return;
                  }
                  void load();
                }}
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

              <Button variant="ghost" class="!p-2 rounded-full" onClick={requestClose}>
                <X size={16} />
              </Button>
            </div>
          </div>

          <Show when={error()}>
            <div class="shrink-0 px-5 py-3 border-b border-dls-border bg-red-2/20 text-red-11 text-xs">
              {error()}
            </div>
          </Show>

          <div class="flex-1 overflow-hidden">
            <div
              class={`h-full grid gap-4 p-5 ${
                showSplit() ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1"
              }`}
            >
              <Show when={mode() !== "preview"}>
                <div class="h-full flex flex-col overflow-hidden">
                  <div class="text-[11px] uppercase tracking-tight font-bold text-dls-secondary px-1 pb-2">
                    Markdown
                  </div>
                  <textarea
                    ref={textareaRef}
                    value={draft()}
                    onInput={(event) => setDraft(event.currentTarget.value)}
                    disabled={loading()}
                    spellcheck={false}
                    class="flex-1 w-full resize-none rounded-xl border border-dls-border bg-dls-surface px-4 py-3 font-mono text-[13px] leading-relaxed text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgb(var(--dls-accent-rgb)_/_0.25)]"
                  />
                  <Show when={writeDisabledReason()}>
                    {(reason) => (
                      <div class="mt-2 text-[11px] text-dls-secondary">{reason()}</div>
                    )}
                  </Show>
                </div>
              </Show>

              <Show when={showPreview()}>
                <div class="h-full flex flex-col overflow-hidden">
                  <div class="text-[11px] uppercase tracking-tight font-bold text-dls-secondary px-1 pb-2">
                    Preview
                  </div>
                  <div
                    class="flex-1 overflow-auto rounded-xl border border-dls-border bg-dls-surface px-5 py-4 text-sm leading-relaxed text-dls-text"
                    classList={{
                      "[&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2": true,
                      "[&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2": true,
                      "[&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-2": true,
                      "[&_p]:my-3": true,
                      "[&_ul]:my-3 [&_ul]:pl-5 [&_ul]:list-disc": true,
                      "[&_ol]:my-3 [&_ol]:pl-5 [&_ol]:list-decimal": true,
                      "[&_li]:my-1": true,
                      "[&_blockquote]:border-l-2 [&_blockquote]:border-dls-border [&_blockquote]:pl-4 [&_blockquote]:text-dls-secondary [&_blockquote]:my-4": true,
                      "[&_hr]:my-4 [&_hr]:border-dls-border": true,
                    }}
                    innerHTML={previewHtml()}
                  />
                </div>
              </Show>
            </div>
          </div>
        </div>
      </div>

      <ConfirmModal
        open={confirmCloseOpen()}
        title="Discard changes?"
        message="You have unsaved edits in this file."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        variant="warning"
        onConfirm={() => {
          setConfirmCloseOpen(false);
          props.onClose();
        }}
        onCancel={() => setConfirmCloseOpen(false)}
      />

      <ConfirmModal
        open={confirmOverwriteOpen()}
        title="File changed on disk"
        message="This file was modified after you loaded it. Overwrite anyway?"
        confirmLabel="Overwrite"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          setConfirmOverwriteOpen(false);
          void save({ force: true });
        }}
        onCancel={() => setConfirmOverwriteOpen(false)}
      />

      <ConfirmModal
        open={confirmReloadOpen()}
        title="Reload from disk?"
        message="This will discard your unsaved edits."
        confirmLabel="Reload"
        cancelLabel="Cancel"
        variant="warning"
        onConfirm={() => {
          setConfirmReloadOpen(false);
          void load();
        }}
        onCancel={() => setConfirmReloadOpen(false)}
      />
    </Show>
  );
}
