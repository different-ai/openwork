import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { marked } from "marked";
import { FileText, RefreshCcw, Save, X } from "lucide-solid";

import Button from "../button";
import type { OpenworkServerClient, OpenworkWorkspaceFileContent, OpenworkWorkspaceFileWriteResult } from "../../lib/openwork-server";
import { OpenworkServerError } from "../../lib/openwork-server";

export type MarkdownEditorSidebarProps = {
  open: boolean;
  path: string | null;
  workspaceId: string | null;
  client: OpenworkServerClient | null;
  onClose: () => void;
  onToast?: (message: string) => void;
};

const isMarkdown = (value: string) => /\.(md|mdx|markdown)$/i.test(value);
const basename = (value: string) => value.split(/[/\\]/).filter(Boolean).pop() ?? value;
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
        <pre class="overflow-x-auto whitespace-pre text-[13px] leading-relaxed font-mono"><code>${escapeHtml(text)}</code></pre>
      </div>
    `;
  };

  renderer.codespan = ({ text }) => {
    return `<code class="rounded-md px-1.5 py-0.5 text-[13px] font-mono bg-dls-active text-dls-text">${escapeHtml(text)}</code>`;
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

export default function MarkdownEditorSidebar(props: MarkdownEditorSidebarProps) {
  let textareaRef: HTMLTextAreaElement | undefined;

  const [loading, setLoading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [original, setOriginal] = createSignal("");
  const [draft, setDraft] = createSignal("");
  const [loadedPath, setLoadedPath] = createSignal<string | null>(null);
  const [view, setView] = createSignal<"write" | "preview">("write");
  const [baseUpdatedAt, setBaseUpdatedAt] = createSignal<number | null>(null);

  const [confirmDiscardClose, setConfirmDiscardClose] = createSignal(false);
  const [confirmDiscardReload, setConfirmDiscardReload] = createSignal(false);
  const [confirmOverwrite, setConfirmOverwrite] = createSignal(false);

  const [pendingPath, setPendingPath] = createSignal<string | null>(null);
  const [pendingReason, setPendingReason] = createSignal<"switch" | "reload" | null>(null);

  const path = createMemo(() => props.path?.trim() ?? "");
  const title = createMemo(() => (path() ? basename(path()) : "Markdown"));
  const dirty = createMemo(() => draft() !== original());
  const canWrite = createMemo(() => Boolean(props.client && props.workspaceId));
  const canSave = createMemo(() => dirty() && !saving() && canWrite());
  const writeDisabledReason = createMemo(() => {
    if (canWrite()) return null;
    return "Connect to an OpenWork server workspace to edit files.";
  });

  const previewSource = useThrottledValue(() => (props.open ? draft() : ""), 120);
  const previewHtml = createMemo(() => {
    const text = previewSource();
    if (!props.open) return "";
    if (!text.trim()) return "";
    try {
      const renderer = createMarkdownRenderer();
      const result = marked.parse(text, { breaks: true, gfm: true, renderer, async: false });
      return typeof result === "string" ? result : "";
    } catch {
      return "";
    }
  });

  const resetState = () => {
    setLoading(false);
    setSaving(false);
    setError(null);
    setOriginal("");
    setDraft("");
    setLoadedPath(null);
    setView("write");
    setBaseUpdatedAt(null);
    setConfirmDiscardClose(false);
    setConfirmDiscardReload(false);
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
    if (!target) return;
    if (!isMarkdown(target)) {
      setError("Only markdown files are supported.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = (await client.readWorkspaceFile(workspaceId, target)) as OpenworkWorkspaceFileContent;
      setOriginal(result.content ?? "");
      setDraft(result.content ?? "");
      setLoadedPath(target);
      setBaseUpdatedAt(typeof result.updatedAt === "number" ? result.updatedAt : null);
      requestAnimationFrame(() => textareaRef?.focus());
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
    setConfirmDiscardReload(true);
  };

  createEffect(() => {
    if (!props.open) {
      resetState();
      return;
    }

    const target = path();
    if (!target) return;

    if (loading() || pendingReason() === "switch") return;

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

  createEffect(() => {
    if (!props.open) return;
    if (view() !== "write") return;
    requestAnimationFrame(() => textareaRef?.focus());
  });

  return (
    <Show when={props.open}>
      <aside class="fixed inset-y-0 right-0 z-50 w-full md:w-[760px] lg:w-[920px] bg-dls-sidebar border-l border-dls-border flex flex-col">
        <div class="shrink-0 px-4 py-3 border-b border-dls-border flex items-center gap-3">
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
            </div>
            <div class="text-[11px] text-dls-secondary font-mono truncate" title={path()}>
              {path()}
            </div>
          </div>

          <div class="flex items-center gap-2">
            <div class="flex items-center rounded-lg border border-dls-border bg-dls-surface p-1">
              <button
                type="button"
                class={`h-7 px-2.5 rounded-md text-xs font-medium transition-colors ${
                  view() === "write"
                    ? "bg-dls-active text-dls-text"
                    : "text-dls-secondary hover:text-dls-text"
                }`}
                onClick={() => setView("write")}
              >
                Write
              </button>
              <button
                type="button"
                class={`h-7 px-2.5 rounded-md text-xs font-medium transition-colors ${
                  view() === "preview"
                    ? "bg-dls-active text-dls-text"
                    : "text-dls-secondary hover:text-dls-text"
                }`}
                onClick={() => setView("preview")}
              >
                Preview
              </button>
            </div>

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

            <Button variant="ghost" class="!p-2 rounded-full" onClick={requestClose}>
              <X size={16} />
            </Button>
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
            <div class="min-w-0">
              File changed since load. Overwrite anyway?
            </div>
            <div class="shrink-0 flex items-center gap-2">
              <Button
                variant="outline"
                class="text-xs h-8 py-0 px-3"
                onClick={() => setConfirmOverwrite(false)}
              >
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

        <Show when={confirmDiscardReload()}>
          <div class="shrink-0 px-4 py-2 border-b border-dls-border bg-amber-2/20 text-amber-11 text-xs flex items-center justify-between gap-3">
            <div class="min-w-0">Discard unsaved changes and reload from disk?</div>
            <div class="shrink-0 flex items-center gap-2">
              <Button
                variant="outline"
                class="text-xs h-8 py-0 px-3"
                onClick={() => setConfirmDiscardReload(false)}
              >
                Cancel
              </Button>
              <Button
                variant="secondary"
                class="text-xs h-8 py-0 px-3"
                onClick={() => {
                  setConfirmDiscardReload(false);
                  const target = path();
                  if (target) void load(target);
                }}
              >
                Reload
              </Button>
            </div>
          </div>
        </Show>

        <Show when={confirmDiscardClose()}>
          <div class="shrink-0 px-4 py-2 border-b border-dls-border bg-amber-2/20 text-amber-11 text-xs flex items-center justify-between gap-3">
            <div class="min-w-0">Discard unsaved changes and close?</div>
            <div class="shrink-0 flex items-center gap-2">
              <Button
                variant="outline"
                class="text-xs h-8 py-0 px-3"
                onClick={() => setConfirmDiscardClose(false)}
              >
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
              <Button
                class="text-xs h-8 py-0 px-3"
                onClick={() => void save()}
                disabled={!canSave()}
              >
                Save & switch
              </Button>
            </div>
          </div>
        </Show>

        <div class="flex-1 overflow-hidden">
          <div class="h-full p-4">
            <Show
              when={view() === "preview"}
              fallback={
                <textarea
                  ref={textareaRef}
                  value={draft()}
                  onInput={(event) => setDraft(event.currentTarget.value)}
                  disabled={loading()}
                  spellcheck={false}
                  class="h-full w-full resize-none rounded-xl border border-dls-border bg-dls-surface px-4 py-3 font-mono text-[13px] leading-relaxed text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgb(var(--dls-accent-rgb)_/_0.25)]"
                />
              }
            >
              <div class="relative h-full">
                <div
                  class="h-full overflow-auto rounded-xl border border-dls-border bg-dls-surface px-5 py-4 text-sm leading-relaxed text-dls-text"
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
                <Show when={!previewHtml()}>
                  <div class="pointer-events-none absolute inset-x-6 top-6 text-xs text-dls-secondary">
                    Nothing to preview yet. Start typing markdown in Write mode.
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </div>
      </aside>
    </Show>
  );
}
