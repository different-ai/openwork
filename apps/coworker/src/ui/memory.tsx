import { useCallback, useEffect, useRef, useState } from "react";
import { coworkerBridge, type CoworkerMemoryFile, type CoworkerSummary, type LongTermMemory, type MemoryChange } from "@/lib/bridge";
import { relativeTime } from "@/lib/activity-summary";
import { describeMemoryChange } from "@/lib/memory-changes";
import { Button, Empty, ErrorNote, inputClass } from "@/ui/kit";
import { Markdown } from "@/ui/markdown";

type MemoryTab = "soul" | "working" | "long-term";
type EditorMode = "view" | "edit";

const FIXED_TABS: { id: MemoryTab; fileId: string; label: string }[] = [
  { id: "soul", fileId: "soul", label: "Soul" },
  { id: "working", fileId: "working", label: "Working memory" },
];

/**
 * Memory stays inspectable Markdown on disk. The panel shows it as structure:
 * identity and working memory as rendered pages with an editor behind them,
 * and long-term memory as the list the index describes, where each memory can
 * be read, edited, or forgotten together with its index line.
 */
export function MemoryPanel({ coworker }: { coworker: CoworkerSummary }) {
  const [tab, setTab] = useState<MemoryTab>("working");
  const [files, setFiles] = useState<CoworkerMemoryFile[]>([]);
  const [memories, setMemories] = useState<LongTermMemory[] | null>(null);
  const [changes, setChanges] = useState<MemoryChange[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [indexOpen, setIndexOpen] = useState(false);
  const [error, setError] = useState("");
  // Bumped after an undo so the open page re-reads its file at once instead of on its next poll.
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [nextFiles, nextMemories, nextChanges] = await Promise.all([
        coworkerBridge.files.list(coworker.slug),
        coworkerBridge.memory.list(coworker.slug),
        coworkerBridge.memory.changes(coworker.slug, 12),
      ]);
      setFiles(nextFiles);
      setMemories(nextMemories);
      setChanges(nextChanges);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [coworker.slug]);

  useEffect(() => {
    setTab("working");
    setSelectedFile(null);
    setIndexOpen(false);
    setMemories(null);
    setChanges([]);
    void refresh();
  }, [refresh]);

  // The coworker remembers, promotes, and rewrites while working; the list and the changes follow.
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function undo(change: MemoryChange) {
    try {
      await coworkerBridge.memory.undo(coworker.slug, change.id);
      setError("");
      setRevision((value) => value + 1);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const indexFile = files.find((file) => file.id === "index") ?? null;
  const selectedMemory = selectedFile ? memories?.find((memory) => memory.file === selectedFile) ?? null : null;

  function openTab(next: MemoryTab) {
    setTab(next);
    setSelectedFile(null);
    setIndexOpen(false);
  }

  return (
    <div className="space-y-3" data-testid="memory-panel">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs leading-relaxed text-mist">Human-readable context that {coworker.name} can maintain.</p>
        <Button variant="ghost" className="shrink-0 px-2 text-xs" onClick={() => void refresh()}>Refresh</Button>
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <nav className="flex gap-1 overflow-x-auto pb-1" aria-label="Memory">
        {FIXED_TABS.map((entry) => (
          <TabButton key={entry.id} active={tab === entry.id} testId={`memory-tab-${entry.id}`} onClick={() => openTab(entry.id)}>
            {entry.label}
          </TabButton>
        ))}
        <TabButton active={tab === "long-term"} testId="memory-tab-long-term" onClick={() => openTab("long-term")}>
          Long-term
          {memories && memories.length > 0 ? (
            <span className="ml-1.5 rounded-full bg-white/8 px-1.5 py-px text-[10px] tabular-nums text-mist" data-testid="memory-count">
              {memories.length}
            </span>
          ) : null}
        </TabButton>
      </nav>
      {tab !== "long-term" ? (
        <FixedFileTab slug={coworker.slug} revision={revision} file={files.find((file) => file.id === FIXED_TABS.find((entry) => entry.id === tab)?.fileId) ?? null} />
      ) : indexOpen && indexFile ? (
        <div className="space-y-3" data-testid="memory-index-editor">
          <BackLink onClick={() => setIndexOpen(false)}>All memories</BackLink>
          <div>
            <h3 className="text-sm font-semibold text-snow">Index file</h3>
            <p className="mt-0.5 text-xs leading-relaxed text-mist">
              The map {coworker.name} loads every turn: one line per memory. Edit it only to fix a line the list above did not understand.
            </p>
          </div>
          <FileEditor key={indexFile.path} slug={coworker.slug} path={indexFile.path} label="Memory index" defaultMode="edit" onSaved={() => void refresh()} />
        </div>
      ) : selectedMemory ? (
        <MemoryDetail
          key={selectedMemory.file}
          coworker={coworker}
          memory={selectedMemory}
          onBack={() => setSelectedFile(null)}
          onChanged={() => void refresh()}
          onDeleted={() => {
            setSelectedFile(null);
            void refresh();
          }}
          onError={setError}
        />
      ) : (
        <MemoryList
          coworker={coworker}
          memories={memories}
          onSelect={(memory) => setSelectedFile(memory.file)}
          onCreated={(memory) => {
            setSelectedFile(memory.file);
            void refresh();
          }}
          onOpenIndex={indexFile ? () => setIndexOpen(true) : undefined}
          onError={setError}
        />
      )}
      <RecentChanges coworker={coworker} changes={changes} onUndo={(change) => void undo(change)} />
    </div>
  );
}

/**
 * What changed in memory and soul lately, newest first, each with Undo. The
 * coworker's changes read as they did in the conversation; the person's edits
 * and undos are named too, so every line here can be trusted and reversed.
 */
function RecentChanges({ coworker, changes, onUndo }: { coworker: CoworkerSummary; changes: MemoryChange[]; onUndo: (change: MemoryChange) => void }) {
  return (
    <section className="border-t border-line pt-3" data-testid="memory-recent-changes">
      <div className="flex items-center justify-between gap-2 px-1">
        <h3 className="text-[11px] font-semibold text-mist">Recent changes</h3>
        {changes.length > 0 ? <span className="text-[10px] text-mist">{changes.length}</span> : null}
      </div>
      {changes.length === 0 ? (
        <p className="mt-1.5 px-1 text-[11px] leading-relaxed text-mist">Nothing yet. What {coworker.name} remembers or changes about itself shows up here, and you can undo it.</p>
      ) : (
        <ul className="mt-1.5 divide-y divide-line/70" data-testid="memory-change-list">
          {changes.map((change) => {
            const label = describeMemoryChange(change, changes);
            const when = relativeTime(change.at);
            return (
              <li key={change.id} className="flex items-center gap-2 py-1.5" data-testid="memory-change-row" data-change-id={change.id} data-tool={change.tool} data-undone={change.undone ? "true" : "false"}>
                <span className={`min-w-0 flex-1 truncate text-[11px] leading-relaxed ${change.undone ? "text-mist line-through decoration-mist/60" : "text-snow"}`} title={label} data-testid="memory-change-label">
                  {label}
                </span>
                {when ? <span className="shrink-0 text-[10px] text-mist">{when === "now" ? "just now" : `${when} ago`}</span> : null}
                <button
                  type="button"
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-spark transition-colors hover:bg-spark/10 disabled:cursor-default disabled:text-mist/50 disabled:hover:bg-transparent"
                  aria-label={`Undo: ${label}`}
                  disabled={change.undone}
                  onClick={() => onUndo(change)}
                >
                  {change.undone ? "Undone" : "Undo"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function TabButton({ active, testId, onClick, children }: { active: boolean; testId: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
      className={`flex shrink-0 items-center rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
        active ? "bg-panel-2 text-snow" : "text-mist hover:bg-panel hover:text-snow"
      }`}
    >
      {children}
    </button>
  );
}

function BackLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-mist transition-colors hover:text-snow" onClick={onClick}>
      <span aria-hidden="true">‹</span>
      {children}
    </button>
  );
}

function describeUpdated(updatedAt: number): string {
  const ago = relativeTime(updatedAt);
  if (!ago) return "";
  return ago === "now" ? "Updated just now" : `Updated ${ago} ago`;
}

function FixedFileTab({ slug, file, revision }: { slug: string; file: CoworkerMemoryFile | null; revision: number }) {
  if (!file) return <Empty>No memory files yet.</Empty>;
  return <FileEditor key={`${file.path}:${revision}`} slug={slug} path={file.path} label={file.label} defaultMode="view" />;
}

/** The list the index describes, joined with what is actually on disk. */
function MemoryList({
  coworker,
  memories,
  onSelect,
  onCreated,
  onOpenIndex,
  onError,
}: {
  coworker: CoworkerSummary;
  memories: LongTermMemory[] | null;
  onSelect: (memory: LongTermMemory) => void;
  onCreated: (memory: LongTermMemory) => void;
  onOpenIndex?: () => void;
  onError: (message: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const memory = await coworkerBridge.memory.create(coworker.slug, { title: title.trim(), summary: summary.trim() });
      setCreating(false);
      setTitle("");
      setSummary("");
      onError("");
      onCreated(memory);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs leading-relaxed text-mist">
          Durable facts {coworker.name} promotes from working memory, one file each. Select one to read, edit, or forget it.
        </p>
        {!creating ? (
          <Button variant="ghost" className="shrink-0 px-2 text-xs" onClick={() => setCreating(true)}>New memory</Button>
        ) : null}
      </div>
      {creating ? (
        <form
          className="space-y-2 rounded-2xl border border-line bg-ink p-3"
          data-testid="memory-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <input
            aria-label="Memory title"
            className={inputClass}
            placeholder="What is this memory about?"
            value={title}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
          />
          <input
            aria-label="One-line summary for the index"
            className={inputClass}
            placeholder="One line for the index (optional)"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" type="button" className="px-2 text-xs" disabled={busy} onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" type="submit" className="px-2 text-xs" disabled={busy || !title.trim()}>Create memory</Button>
          </div>
        </form>
      ) : null}
      {memories === null ? (
        <Empty>Reading memory…</Empty>
      ) : memories.length === 0 ? (
        <Empty>No long-term memories yet. They appear here as {coworker.name} promotes durable facts from working memory.</Empty>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-ink" data-testid="memory-list">
          {memories.map((memory) => (
            <li key={memory.file}>
              <button
                type="button"
                data-testid="memory-row"
                data-file={memory.file}
                className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/4 focus-visible:bg-white/4 focus-visible:outline-none"
                onClick={() => onSelect(memory)}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-snow">{memory.title}</span>
                    <MemoryBadge memory={memory} />
                  </div>
                  {memory.summary && memory.summary !== memory.title ? (
                    <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-mist">{memory.summary}</p>
                  ) : null}
                </div>
                <span className="shrink-0 pt-0.5 text-[10px] text-mist">{describeUpdated(memory.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {onOpenIndex ? (
        <p className="text-[10px] leading-relaxed text-mist">
          This list is read from the index {coworker.name} keeps.{" "}
          <button type="button" className="underline decoration-mist/50 underline-offset-2 hover:text-snow" onClick={onOpenIndex}>
            Open the index file
          </button>
        </p>
      ) : null}
    </div>
  );
}

function MemoryBadge({ memory }: { memory: LongTermMemory }) {
  if (!memory.exists) {
    return <span className="shrink-0 rounded-full border border-rose/35 px-1.5 py-px text-[10px] text-rose">File missing</span>;
  }
  if (!memory.indexed) {
    return <span className="shrink-0 rounded-full border border-amber/35 px-1.5 py-px text-[10px] text-amber">Not in index</span>;
  }
  return null;
}

/** One memory: read it, edit it, or forget it together with its index line. */
function MemoryDetail({
  coworker,
  memory,
  onBack,
  onChanged,
  onDeleted,
  onError,
}: {
  coworker: CoworkerSummary;
  memory: LongTermMemory;
  onBack: () => void;
  onChanged: () => void;
  onDeleted: () => void;
  onError: (message: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!confirming) {
      setArmed(false);
      return;
    }
    const timer = window.setTimeout(() => setArmed(true), 500);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  async function act(run: () => Promise<void>, after: () => void) {
    setBusy(true);
    try {
      await run();
      onError("");
      after();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const meta = [memory.summary && memory.summary !== memory.title ? memory.summary : "", describeUpdated(memory.updatedAt)].filter(Boolean);

  return (
    <div className="space-y-3" data-testid="memory-detail" data-file={memory.file}>
      <BackLink onClick={onBack}>All memories</BackLink>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-snow">{memory.title}</h3>
            <MemoryBadge memory={memory} />
          </div>
          {meta.length > 0 ? <p className="mt-0.5 text-xs leading-relaxed text-mist">{meta.join(" · ")}</p> : null}
          <p className="mt-0.5 font-mono text-[10px] text-mist/80">{memory.path}</p>
        </div>
        {!confirming ? (
          <Button variant="ghost" className="shrink-0 px-2 text-xs text-rose hover:text-rose" disabled={busy} onClick={() => setConfirming(true)}>
            {memory.exists ? "Delete…" : "Remove from index…"}
          </Button>
        ) : null}
      </div>
      {confirming ? (
        <div className="space-y-2 rounded-2xl border border-rose/25 bg-rose/5 p-3" data-testid="memory-delete-confirm">
          <p className="text-xs leading-relaxed text-rose">
            {memory.exists
              ? `Delete this memory? The file and its line in the index go together, and ${coworker.name} will no longer recall it.`
              : "Remove the index line? The file is already gone."}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" className="flex-1 text-xs" disabled={busy} onClick={() => setConfirming(false)}>Keep</Button>
            <Button
              variant="danger"
              className="flex-1 text-xs"
              disabled={busy || !armed}
              onClick={() => void act(() => coworkerBridge.memory.remove(coworker.slug, memory.file).then(() => undefined), onDeleted)}
            >
              {busy ? "Deleting…" : memory.exists ? "Delete memory" : "Remove line"}
            </Button>
          </div>
        </div>
      ) : null}
      {memory.exists && !memory.indexed ? (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-amber/25 bg-amber/5 px-3 py-2">
          <p className="text-xs leading-relaxed text-amber">
            {coworker.name} wrote this file but has not listed it, so it will not come to mind on its own.
          </p>
          <Button
            variant="ghost"
            className="shrink-0 px-2 text-xs"
            disabled={busy}
            onClick={() => void act(() => coworkerBridge.memory.index(coworker.slug, memory.file).then(() => undefined), onChanged)}
          >
            Add to index
          </Button>
        </div>
      ) : null}
      {memory.exists ? (
        <FileEditor key={memory.path} slug={coworker.slug} path={memory.path} label={memory.title} defaultMode="view" onSaved={onChanged} />
      ) : (
        <Empty>Only the index line remains; the file is no longer in memory/long-term.</Empty>
      )}
    </div>
  );
}

/**
 * One Markdown file, rendered by default with the editor a click away. The
 * editor follows coworker writes live without replacing unsaved human edits.
 */
function FileEditor({
  slug,
  path,
  label,
  defaultMode,
  onSaved,
}: {
  slug: string;
  path: string;
  label: string;
  defaultMode: EditorMode;
  onSaved?: () => void;
}) {
  const [mode, setMode] = useState<EditorMode>(defaultMode);
  const [content, setContent] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void coworkerBridge.files
      .read(slug, path)
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        setSavedContent(text);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [slug, path]);

  const editorState = useRef({ content: "", savedContent: "" });
  editorState.current = { content: content ?? "", savedContent };
  useEffect(() => {
    const timer = window.setInterval(() => {
      void coworkerBridge.files
        .read(slug, path)
        .then((text) => {
          const { content: currentContent, savedContent: currentSaved } = editorState.current;
          const dirty = currentContent !== currentSaved;
          if (!dirty && text !== currentSaved) {
            setContent(text);
            setSavedContent(text);
          }
        })
        .catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [slug, path]);

  async function save() {
    if (content === null) return;
    try {
      await coworkerBridge.files.write(slug, path, content);
      setSavedContent(content);
      setError("");
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const dirty = content !== null && content !== savedContent;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex rounded-lg border border-line p-0.5" role="group" aria-label={`${label} display`}>
          <ModeButton active={mode === "view"} onClick={() => setMode("view")}>View</ModeButton>
          <ModeButton active={mode === "edit"} onClick={() => setMode("edit")}>Edit</ModeButton>
        </div>
        {mode === "edit" ? (
          <Button variant="primary" className="px-2 text-xs" disabled={!dirty} onClick={() => void save()}>{dirty ? "Save" : "Saved"}</Button>
        ) : null}
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {content === null ? null : mode === "view" ? (
        <div className="min-h-[12rem] rounded-2xl border border-line bg-ink p-4" data-testid="memory-view">
          {content.trim() ? <Markdown text={content} /> : <p className="text-sm text-mist">Nothing written yet.</p>}
        </div>
      ) : (
        <>
          <textarea
            aria-label={`${label} memory`}
            className="h-[52vh] w-full resize-none rounded-2xl border border-line bg-ink p-3 font-mono text-xs leading-relaxed text-snow focus:border-spark/60 focus:outline-none"
            value={content}
            spellCheck={false}
            onChange={(event) => setContent(event.target.value)}
          />
          <p className="text-[10px] leading-relaxed text-mist">Live-following coworker edits. Your unsaved changes are never replaced.</p>
        </>
      )}
    </div>
  );
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${active ? "bg-panel-2 text-snow" : "text-mist hover:text-snow"}`}
    >
      {children}
    </button>
  );
}
