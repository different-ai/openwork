import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { relativeTime } from "@/lib/activity-summary";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import {
  askToUpdatePrompt,
  cardSubline,
  groupDocuments,
  type CoworkerDocument,
  type CoworkerDocumentSummary,
  type DocumentCardData,
  type DocumentRevision,
} from "@/lib/documents";
import { describeDiff, lineDiff, sideBySide } from "@/lib/line-diff";
import { Button, Empty, ErrorNote, IconButton, inputClass } from "@/ui/kit";
import { DocumentMarkdown } from "@/ui/markdown";

/** A page with a folded corner: the Documents strip icon. */
export function DocumentsIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 2.25h5.25L12.5 5.5v7.75a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5v-10.5a.5.5 0 0 1 .5-.5Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M9.25 2.25V5.5h3.25M5.75 8.25h4.5M5.75 10.75h4.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** How often the list re-reads while a coworker is selected; a tool call in the transcript refreshes it sooner. */
const DOCUMENTS_POLL_MS = 5_000;
const LAST_OPENED_KEY = "open-coworker.documents-opened";

function readLastOpened(slug: string): number {
  try {
    const raw = window.localStorage.getItem(`${LAST_OPENED_KEY}.${slug}`);
    const value = raw ? Number(raw) : 0;
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** Remember when the person last looked at the Documents view, for the strip icon's dot. */
export function markDocumentsOpened(slug: string, at: number = Date.now()): void {
  try {
    window.localStorage.setItem(`${LAST_OPENED_KEY}.${slug}`, String(at));
  } catch {
    // Without storage the dot simply shows more often.
  }
}

export function lastDocumentsOpened(slug: string): number {
  return readLastOpened(slug);
}

/** The coworker's documents, kept fresh by a light poll plus explicit refreshes. */
export function useDocuments(slug: string, refreshKey = 0): { documents: CoworkerDocumentSummary[] | null; refresh: () => Promise<void>; error: string } {
  const [documents, setDocuments] = useState<CoworkerDocumentSummary[] | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const next = await coworkerBridge.documents.list(slug);
      setDocuments((current) => (current && JSON.stringify(current) === JSON.stringify(next) ? current : next));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [slug]);
  useEffect(() => {
    setDocuments(null);
    void refresh();
    const timer = window.setInterval(() => void refresh(), DOCUMENTS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, refreshKey]);
  return { documents, refresh, error };
}

function whenLabel(updatedAt: number): string {
  const ago = relativeTime(updatedAt);
  if (!ago) return "";
  return ago === "now" ? "just now" : `${ago} ago`;
}

function byLabel(document: Pick<CoworkerDocumentSummary, "updatedBy">, coworkerName: string): string {
  return document.updatedBy === "person" ? "by you" : `by ${coworkerName}`;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A row in the Documents view: title, one-line summary, when, and who. */
function DocumentRow({ document, coworkerName, onSelect }: { document: CoworkerDocumentSummary; coworkerName: string; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        data-testid="document-row"
        data-document-id={document.id}
        data-status={document.status}
        className="flex w-full items-start gap-3 px-1 py-2.5 text-left transition-colors hover:bg-white/4 focus-visible:bg-white/4 focus-visible:outline-none"
        onClick={onSelect}
      >
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-snow">{document.title}</span>
          {document.summary ? <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-mist">{document.summary}</p> : null}
        </div>
        <span className="shrink-0 pt-0.5 text-right text-[10px] leading-relaxed text-mist">
          {whenLabel(document.updatedAt)}
          <br />
          {byLabel(document, coworkerName)}
        </span>
      </button>
    </li>
  );
}

function RowList({ documents, coworkerName, onSelect, testId }: { documents: CoworkerDocumentSummary[]; coworkerName: string; onSelect: (id: string) => void; testId: string }) {
  return (
    <ul className="divide-y divide-line" data-testid={testId}>
      {documents.map((document) => (
        <DocumentRow key={document.id} document={document} coworkerName={coworkerName} onSelect={() => onSelect(document.id)} />
      ))}
    </ul>
  );
}

/**
 * The Documents view: two flat groups — Active (by last update) and Put aside
 * (closed by default) — plus Archived behind a quiet link. Selecting a row opens
 * the document in the panel.
 */
export function DocumentsPanel({
  coworker,
  documents,
  error,
  onRefresh,
  openRequest,
  onAskToUpdate,
  canOpenBeside,
  onOpenBeside,
}: {
  coworker: CoworkerSummary;
  documents: CoworkerDocumentSummary[] | null;
  error: string;
  onRefresh: () => Promise<void>;
  /** From a card's Open: show this document; the id makes repeat requests distinct. */
  openRequest?: { id: number; documentId: string } | null;
  /** Drop "Update 'Title' with …" into the composer. */
  onAskToUpdate: (text: string) => void;
  canOpenBeside: boolean;
  onOpenBeside: (documentId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const handledRequest = useRef<number | null>(null);
  useEffect(() => {
    markDocumentsOpened(coworker.slug);
  }, [coworker.slug, documents]);
  useEffect(() => {
    if (!openRequest || handledRequest.current === openRequest.id) return;
    handledRequest.current = openRequest.id;
    setSelectedId(openRequest.documentId);
  }, [openRequest]);
  const groups = useMemo(() => groupDocuments(documents ?? []), [documents]);

  if (selectedId) {
    return (
      <DocumentReader
        coworker={coworker}
        documentId={selectedId}
        onBack={() => setSelectedId("")}
        onChanged={onRefresh}
        onAskToUpdate={onAskToUpdate}
        onOpenDocument={setSelectedId}
        canOpenBeside={canOpenBeside}
        onOpenBeside={() => onOpenBeside(selectedId)}
      />
    );
  }

  return (
    <div className="space-y-4" data-testid="documents-panel">
      <p className="text-xs leading-relaxed text-mist">
        The depth behind {coworker.name}'s replies: plans, briefs, comparisons, notes. {coworker.name} keeps about five in play and puts the rest aside.
      </p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {documents === null ? (
        <Empty>Reading documents…</Empty>
      ) : documents.length === 0 ? (
        <Empty>No documents yet. Ask {coworker.name} for a plan, a comparison, or research and it will write one here.</Empty>
      ) : (
        <>
          <section className="space-y-2">
            <h3 className="px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-mist/80">Active · {groups.active.length}</h3>
            {groups.active.length > 0 ? (
              <RowList documents={groups.active} coworkerName={coworker.name} onSelect={setSelectedId} testId="documents-active" />
            ) : (
              <p className="px-1 text-xs text-mist">Nothing in play right now.</p>
            )}
          </section>
          {groups.aside.length > 0 ? (
            <details className="group space-y-2" data-testid="documents-aside">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-mist/80 marker:hidden hover:text-snow">
                <span>Put aside · {groups.aside.length}</span>
                <span className="text-mist/60 transition-transform group-open:rotate-90" aria-hidden="true">›</span>
              </summary>
              <RowList documents={groups.aside} coworkerName={coworker.name} onSelect={setSelectedId} testId="documents-aside-list" />
            </details>
          ) : null}
          {groups.archived.length > 0 ? (
            <div className="space-y-2">
              <button
                type="button"
                className="px-1 text-[10px] text-mist underline decoration-mist/40 underline-offset-2 hover:text-snow"
                data-testid="documents-archived-link"
                onClick={() => setShowArchived((value) => !value)}
              >
                {showArchived ? "Hide archived" : `Archived · ${groups.archived.length}`}
              </button>
              {showArchived ? <RowList documents={groups.archived} coworkerName={coworker.name} onSelect={setSelectedId} testId="documents-archived" /> : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

type ReaderMode = "read" | "edit" | "history";

/**
 * One document: a reading header (title, updated, revision), the rendered
 * Markdown, and the person's actions — Edit in place, Ask <name> to update,
 * Put aside / Make active, Copy, Export, History with a two-pane diff and
 * Restore, and Open beside when the window is wide enough.
 */
export function DocumentReader({
  coworker,
  documentId,
  onBack,
  onChanged,
  onAskToUpdate,
  onOpenDocument,
  canOpenBeside,
  onOpenBeside,
  compact = false,
}: {
  coworker: CoworkerSummary;
  documentId: string;
  onBack: () => void;
  onChanged: () => Promise<void>;
  onAskToUpdate: (text: string) => void;
  onOpenDocument: (id: string) => void;
  canOpenBeside: boolean;
  onOpenBeside: () => void;
  /** In the beside pane the header is shorter and Back reads as Close. */
  compact?: boolean;
}) {
  const [document, setDocument] = useState<CoworkerDocument | null>(null);
  const [mode, setMode] = useState<ReaderMode>("read");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setDocument(await coworkerBridge.documents.read(coworker.slug, documentId));
      setError("");
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [coworker.slug, documentId]);

  useEffect(() => {
    setDocument(null);
    setMode("read");
    setNote("");
    void load();
  }, [load]);

  // While reading, follow the coworker's own updates without a manual refresh.
  useEffect(() => {
    if (mode !== "read") return;
    const timer = window.setInterval(() => void load(), DOCUMENTS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, mode]);

  async function run(action: () => Promise<string>): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const result = await action();
      setNote(result);
      await load();
      await onChanged();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!document) {
    return (
      <div className="space-y-3">
        <BackLink onClick={onBack}>{compact ? "Close" : "All documents"}</BackLink>
        {error ? <ErrorNote>{error}</ErrorNote> : <Empty>Opening…</Empty>}
      </div>
    );
  }

  const statusAction = document.status === "archived"
    ? { label: "Bring back", status: "active" as const }
    : document.status === "active"
      ? { label: "Put aside", status: "aside" as const }
      : { label: "Make active", status: "active" as const };

  return (
    <article className="space-y-4" data-testid="document-reader" data-document-id={document.id} data-revision={document.revision} data-status={document.status}>
      <div className="flex items-center justify-between gap-2">
        <BackLink onClick={onBack}>{compact ? "Close" : "All documents"}</BackLink>
        {canOpenBeside && !compact ? (
          <Button variant="ghost" className="px-2 text-xs" onClick={onOpenBeside} data-testid="document-open-beside">Open beside</Button>
        ) : null}
      </div>
      <header className="space-y-1">
        <h3 className="text-lg font-semibold leading-tight tracking-[-0.01em] text-snow" data-testid="document-title">{document.title}</h3>
        <p className="text-[11px] text-mist" data-testid="document-meta">
          Updated {whenLabel(document.updatedAt) || "just now"} · revision {document.revision} · {byLabel(document, coworker.name)}
          {document.status !== "active" ? ` · ${document.status === "aside" ? "put aside" : "archived"}` : ""}
        </p>
        {document.summary && mode !== "edit" ? <p className="text-sm leading-relaxed text-mist">{document.summary}</p> : null}
      </header>
      {mode === "read" ? (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="document-actions">
          <Button variant="ghost" className="px-2 text-xs" onClick={() => { setDraft(document.body); setMode("edit"); }}>Edit</Button>
          <Button variant="ghost" className="px-2 text-xs" onClick={() => onAskToUpdate(askToUpdatePrompt(document.title))}>Ask {coworker.name} to update</Button>
          <Button
            variant="ghost"
            className="px-2 text-xs"
            disabled={busy}
            data-testid="document-status-toggle"
            onClick={() => void run(async () => {
              await coworkerBridge.documents.setStatus(coworker.slug, document.id, statusAction.status);
              return statusAction.status === "aside" ? "Put aside." : "In play again.";
            })}
          >
            {statusAction.label}
          </Button>
          <Button
            variant="ghost"
            className="px-2 text-xs"
            onClick={() => void navigator.clipboard.writeText(`# ${document.title}\n\n${document.body}`).then(() => setNote("Copied.")).catch(() => setError("Could not copy."))}
          >
            Copy
          </Button>
          <Button
            variant="ghost"
            className="px-2 text-xs"
            disabled={busy}
            onClick={() => void run(async () => {
              const result = await coworkerBridge.documents.export(coworker.slug, document.id);
              return result.ok ? `Saved to ${result.path}` : "";
            })}
          >
            Export
          </Button>
          <Button variant="ghost" className="px-2 text-xs" onClick={() => setMode("history")} data-testid="document-history">History</Button>
          {document.status !== "archived" ? (
            <Button
              variant="ghost"
              className="px-2 text-xs text-mist/70"
              disabled={busy}
              data-testid="document-archive"
              onClick={() => void run(async () => {
                await coworkerBridge.documents.setStatus(coworker.slug, document.id, "archived");
                return "Archived. It stays behind the Archived link.";
              })}
            >
              Archive
            </Button>
          ) : null}
        </div>
      ) : null}
      {note ? <p className="text-[11px] text-mint" data-testid="document-note">{note}</p> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {mode === "read" ? (
        <DocumentMarkdown
          text={document.body}
          coworkerPath={coworker.path}
          onOpenDocument={onOpenDocument}
          className="!mx-0 !max-w-none"
        />
      ) : null}
      {mode === "edit" ? (
        <DocumentEditor
          draft={draft}
          onDraftChange={setDraft}
          busy={busy}
          onCancel={() => setMode("read")}
          onSave={() => void run(async () => {
            const saved = await coworkerBridge.documents.save(coworker.slug, document.id, { body: draft });
            setMode("read");
            return saved.changed ? `Saved as revision ${saved.revision}. ${coworker.name} will see your edit next turn.` : "Nothing changed.";
          })}
        />
      ) : null}
      {mode === "history" ? (
        <DocumentHistory
          coworker={coworker}
          document={document}
          onClose={() => setMode("read")}
          onRestored={(revision) => void run(async () => {
            const restored = await coworkerBridge.documents.restore(coworker.slug, document.id, revision);
            setMode("read");
            return `Restored revision ${revision} as revision ${restored.revision}.`;
          })}
        />
      ) : null}
    </article>
  );
}

function BackLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-mist transition-colors hover:text-snow" onClick={onClick} data-testid="document-back">
      <span aria-hidden="true">‹</span>
      {children}
    </button>
  );
}

/** The person edits Markdown in place; saving records the edit as theirs. */
function DocumentEditor({ draft, onDraftChange, busy, onCancel, onSave }: { draft: string; onDraftChange: (value: string) => void; busy: boolean; onCancel: () => void; onSave: () => void }) {
  return (
    <div className="space-y-2" data-testid="document-editor">
      <textarea
        aria-label="Document Markdown"
        className={`${inputClass} min-h-[320px] resize-y font-mono text-[13px] leading-relaxed`}
        value={draft}
        autoFocus
        onChange={(event) => onDraftChange(event.target.value)}
      />
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" className="px-2 text-xs" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button variant="primary" className="px-2 text-xs" disabled={busy} onClick={onSave} data-testid="document-save">Save</Button>
      </div>
    </div>
  );
}

/** Earlier revisions with a two-pane diff against the current text, and Restore. */
function DocumentHistory({
  coworker,
  document,
  onClose,
  onRestored,
}: {
  coworker: CoworkerSummary;
  document: CoworkerDocument;
  onClose: () => void;
  onRestored: (revision: number) => void;
}) {
  const [revisions, setRevisions] = useState<DocumentRevision[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    coworkerBridge.documents.revisions(coworker.slug, document.id)
      .then((list) => {
        if (cancelled) return;
        setRevisions(list);
        setSelected(list[0]?.revision ?? null);
      })
      .catch((cause) => {
        if (!cancelled) setError(messageOf(cause));
      });
    return () => { cancelled = true; };
  }, [coworker.slug, document.id]);
  const chosen = revisions?.find((revision) => revision.revision === selected) ?? null;
  const diff = useMemo(() => (chosen ? lineDiff(chosen.body, document.body) : []), [chosen, document.body]);
  const rows = useMemo(() => sideBySide(diff), [diff]);
  return (
    <section className="space-y-3" data-testid="document-history-view">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-mist/80">History</h4>
        <Button variant="ghost" className="px-2 text-xs" onClick={onClose}>Done</Button>
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {revisions === null ? (
        <Empty>Reading history…</Empty>
      ) : revisions.length === 0 ? (
        <Empty>Only one revision so far.</Empty>
      ) : (
        <>
          <ul className="flex flex-wrap gap-1.5" data-testid="document-revisions">
            {revisions.map((revision) => (
              <li key={revision.revision}>
                <button
                  type="button"
                  data-testid="document-revision"
                  data-revision={revision.revision}
                  aria-pressed={revision.revision === selected}
                  className={`rounded-lg border px-2 py-1 text-[11px] transition-colors ${revision.revision === selected ? "border-spark/40 bg-spark/10 text-snow" : "border-line text-mist hover:text-snow"}`}
                  onClick={() => setSelected(revision.revision)}
                >
                  Revision {revision.revision} · {whenLabel(revision.updatedAt) || "earlier"} · {byLabel(revision, coworker.name)}
                </button>
              </li>
            ))}
          </ul>
          {chosen ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 text-[11px] text-mist">
                <span data-testid="document-diff-summary">Revision {chosen.revision} → current (revision {document.revision}): {describeDiff(diff)}</span>
                <Button variant="ghost" className="px-2 text-xs" onClick={() => onRestored(chosen.revision)} data-testid="document-restore">Restore revision {chosen.revision}</Button>
              </div>
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line/60 font-mono text-[11px] leading-relaxed" data-testid="document-diff">
                <p className="bg-ink px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-mist/80">Revision {chosen.revision}</p>
                <p className="bg-ink px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-mist/80">Current</p>
                {rows.map((row, index) => (
                  <DiffRow key={index} row={row} />
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function DiffRow({ row }: { row: ReturnType<typeof sideBySide>[number] }) {
  const cell = (line: { kind: "same" | "added" | "removed"; text: string } | null) => (
    <pre
      className={`min-w-0 whitespace-pre-wrap break-words px-2 py-0.5 ${line?.kind === "added" ? "bg-mint/10 text-mint" : line?.kind === "removed" ? "bg-rose/10 text-rose" : "bg-ink text-snow/85"}`}
      data-kind={line?.kind ?? "blank"}
    >
      {line ? line.text || " " : " "}
    </pre>
  );
  return (
    <>
      {cell(row.left)}
      {cell(row.right)}
    </>
  );
}

/**
 * The compact card a bubble ends with when the reply's turn created or updated
 * a document: title, summary, up to three highlights, and Open (Open beside when
 * the window allows). One card per document per turn; an update names the
 * section it touched.
 */
export function DocumentCard({ card, onOpen, canOpenBeside, onOpenBeside }: { card: DocumentCardData; onOpen: () => void; canOpenBeside: boolean; onOpenBeside: () => void }) {
  const subline = cardSubline(card);
  return (
    <div className="mt-2 w-full rounded-xl border border-white/10 bg-ink/50 px-3 py-2.5 text-left" data-testid="document-card" data-document-id={card.id} data-action={card.action}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-mist"><DocumentsIcon className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-snow" data-testid="document-card-title">{card.title}</p>
          {subline ? <p className="text-[10px] text-mist" data-testid="document-card-subline">{subline}</p> : null}
          {card.summary ? <p className="mt-0.5 text-xs leading-relaxed text-mist" data-testid="document-card-summary">{card.summary}</p> : null}
          {card.highlights.length > 0 ? (
            <ul className="mt-1.5 space-y-0.5 text-xs text-snow/85" data-testid="document-card-highlights">
              {card.highlights.map((highlight, index) => (
                <li key={index} className="flex gap-1.5"><span className="text-mist" aria-hidden="true">·</span><span className="min-w-0">{highlight}</span></li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <Button variant="default" className="px-2.5 py-1 text-xs" onClick={onOpen} data-testid="document-card-open">Open</Button>
        {canOpenBeside ? <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onOpenBeside}>Open beside</Button> : null}
      </div>
    </div>
  );
}

/** A second column next to the conversation: the document, for reading while the chat goes on. */
export function DocumentBesidePane({
  coworker,
  documentId,
  onClose,
  onChanged,
  onAskToUpdate,
  onOpenDocument,
}: {
  coworker: CoworkerSummary;
  documentId: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onAskToUpdate: (text: string) => void;
  onOpenDocument: (id: string) => void;
}) {
  return (
    <aside className="glass-context flex h-full w-[440px] shrink-0 flex-col border-l border-line" data-testid="document-beside" data-document-id={documentId}>
      <header className="glass-header window-drag flex h-[78px] items-center gap-3 border-b border-line px-4 pt-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-snow">Reading</h2>
        <IconButton label="Close reading pane" className="window-no-drag" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <DocumentReader
          coworker={coworker}
          documentId={documentId}
          onBack={onClose}
          onChanged={onChanged}
          onAskToUpdate={onAskToUpdate}
          onOpenDocument={onOpenDocument}
          canOpenBeside={false}
          onOpenBeside={() => undefined}
          compact
        />
      </div>
    </aside>
  );
}
