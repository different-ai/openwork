import { useEffect, useRef, useState } from "react";
import type { GroupDocument, GroupDocumentSummary, GroupDocumentsApi } from "@/lib/group-documents";
import { Button, Empty, ErrorNote, inputClass } from "@/ui/kit";
import { DocumentMarkdown } from "@/ui/markdown";

export type { GroupDocumentsApi } from "@/lib/group-documents";

type Props = { api: GroupDocumentsApi; groupId: string; openId?: string; onClose: () => void };
const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** A different group remounts the observer so late reads cannot cross group boundaries. */
export function GroupDocuments(props: Props) {
  return <GroupDocumentPanel key={props.groupId} {...props} />;
}

function GroupDocumentPanel({ api, groupId, openId = "", onClose }: Props) {
  const [items, setItems] = useState<GroupDocumentSummary[] | null>(null);
  const [document, setDocument] = useState<GroupDocument | null>(null);
  const [history, setHistory] = useState<GroupDocument[] | null>(null);
  const [preview, setPreview] = useState<GroupDocument | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");
  const [discard, setDiscard] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const request = useRef(0);

  useEffect(() => () => { request.current++; }, []);
  useEffect(() => {
    let cancelled = false;
    let reading = false;
    async function refresh() {
      if (reading) return;
      reading = true;
      try {
        const list = await api.list(groupId);
        if (!cancelled) { setItems(list); setListError(""); }
      } catch (cause) {
        if (!cancelled) { setItems(null); setListError(messageOf(cause)); }
      } finally { reading = false; }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [api, groupId, refreshKey]);

  const [selectedId, setSelectedId] = useState(openId);
  useEffect(() => {
    // An incoming open request must not discard a conflict draft.
    if (!editing && !busy) setSelectedId(openId);
  }, [openId]);
  useEffect(() => {
    const version = ++request.current;
    setDocument(null); setHistory(null); setPreview(null); setError("");
    if (!selectedId) return;
    setBusy(true);
    void api.read(groupId, selectedId).then((value) => {
      if (request.current === version) setDocument(value);
    }).catch((cause: unknown) => {
      if (request.current === version) setError(messageOf(cause));
    }).finally(() => { if (request.current === version) setBusy(false); });
  }, [api, groupId, selectedId]);

  useEffect(() => {
    if (!document || editing || history || busy) return;
    let cancelled = false;
    let reading = false;
    const version = request.current;
    const id = document.id;
    const timer = window.setInterval(() => {
      if (reading) return;
      reading = true;
      void api.read(groupId, id).then((value) => {
        if (!cancelled && request.current === version) { setDocument(value); setError(""); }
      }).catch((cause: unknown) => {
        if (!cancelled && request.current === version) setError(messageOf(cause));
      }).finally(() => { reading = false; });
    }, 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [api, groupId, document?.id, editing, history, busy]);

  async function run(action: () => Promise<void>) {
    request.current++;
    setBusy(true); setError("");
    try { await action(); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }

  function edit() {
    request.current++;
    setTitle(document?.title ?? ""); setBody(document?.body ?? "");
    setEditing(true); setHistory(null); setPreview(null); setError("");
  }

  return (
    <aside className="glass-context flex h-full min-w-0 w-[42%] max-w-[520px] shrink-0 flex-col border-l border-line" aria-label="Shared documents" data-testid="group-documents" data-group-id={groupId}>
      <header className="glass-header window-drag flex min-h-[78px] shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-snow">Shared documents</h2>
        <Button variant="ghost" className="window-no-drag px-2 text-xs" disabled={busy} onClick={() => editing ? setDiscard(true) : onClose()}>Close</Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {discard ? <div className="mb-4 space-y-2 rounded-xl border border-line p-3">
          <p className="text-xs text-mist">Discard this unsaved draft and close?</p>
          <div className="flex flex-wrap gap-2"><Button variant="ghost" onClick={() => setDiscard(false)}>Keep editing</Button><Button onClick={onClose}>Discard draft</Button></div>
        </div> : null}
        {!selectedId && !editing ? <>
          <p className="mb-3 text-xs leading-relaxed text-mist">Plans, briefs and decisions shared with this group. Private coworker documents stay separate.</p>
          <Button className="text-xs" onClick={edit} data-testid="group-document-new">New shared document</Button>
          {listError ? <div className="mt-3"><ErrorNote>{listError}</ErrorNote></div> : items === null ? <Empty>Reading documents...</Empty> : items.length === 0 ? <Empty>No shared documents yet.</Empty> : (
            <ul className="mt-4 divide-y divide-line">{items.map((item) => <li key={item.id}>
              <button type="button" className="w-full px-1 py-2.5 text-left transition-colors hover:bg-white/4 focus-visible:bg-white/4" onClick={() => setSelectedId(item.id)} data-testid="group-document-item" data-document-id={item.id}>
                <span className="block break-words text-sm font-medium text-snow">{item.title}</span>
                {item.summary ? <span className="mt-0.5 block text-xs leading-relaxed text-mist">{item.summary}</span> : null}
                <span className="mt-1 block text-[11px] text-mist">{item.author} · revision {item.revision}</span>
              </button>
            </li>)}</ul>
          )}
        </> : null}
        {editing ? <div className="space-y-3" data-testid="group-document-editor">
          <label className="block text-xs text-mist">Title<input autoFocus disabled={busy} className={`${inputClass} mt-1`} aria-label="Shared document title" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="block text-xs text-mist">Document<textarea disabled={busy} className={`${inputClass} mt-1 min-h-72 resize-y font-mono text-xs`} aria-label="Shared document body" maxLength={100000} value={body} onChange={(event) => setBody(event.target.value)} /></label>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" className="text-xs" disabled={busy || !title.trim()} data-testid="group-document-save" onClick={() => void run(async () => {
              const saved = await api.save(groupId, document ? { id: document.id, expectedRevision: document.revision, title, body } : { title, body });
              setDocument(saved); setSelectedId(saved.id); setEditing(false); setPreview(null); setDiscard(false); setRefreshKey((key) => key + 1);
            })}>Save shared document</Button>
            <Button variant="ghost" className="text-xs" disabled={busy} onClick={() => { setEditing(false); setPreview(null); setError(""); setDiscard(false); }}>Cancel</Button>
          </div>
          {error && document ? <Button variant="ghost" className="text-xs" disabled={busy} data-testid="group-document-compare" onClick={() => void run(async () => { setPreview(await api.read(groupId, document.id)); })}>Compare with latest</Button> : null}
          {preview ? <div className="space-y-2 rounded-xl border border-line p-3" data-testid="group-document-conflict-preview">
            <p className="text-xs text-mist">Latest: revision {preview.revision} by {preview.author}. Your draft above is kept. Reconcile it before saving.</p>
            <h3 className="break-words text-sm font-semibold text-snow">{preview.title}</h3>
            <DocumentMarkdown text={preview.body} className="!mx-0 !max-w-none" />
            <Button className="whitespace-normal text-xs" disabled={busy} onClick={() => { setDocument(preview); setPreview(null); setError(""); }}>I've reconciled my draft with this revision</Button>
          </div> : null}
        </div> : selectedId ? <>
          <Button variant="ghost" className="px-0 text-xs" disabled={busy} onClick={() => setSelectedId("")}>All documents</Button>
          {document ? <article className="mt-3 space-y-3" data-testid="group-document-reader" data-document-id={document.id} data-revision={document.revision}>
            <header>
              <h3 className="break-words text-lg font-semibold leading-tight text-snow">{document.title}</h3>
              <p className="mt-1 text-[11px] text-mist" data-testid="group-document-author">{document.author} · revision {document.revision}</p>
              {document.summary ? <p className="mt-2 text-sm text-mist">{document.summary}</p> : null}
            </header>
            <div className="flex flex-wrap gap-1.5">
              <Button variant="ghost" className="px-2 text-xs" disabled={busy} onClick={edit}>Edit</Button>
              <Button variant="ghost" className="px-2 text-xs" disabled={busy} data-testid="group-document-history" onClick={() => void run(async () => { setHistory(await api.revisions(groupId, document.id)); })}>History</Button>
              <Button variant="ghost" className="px-2 text-xs" disabled={busy} onClick={() => void run(async () => { setDocument(await api.read(groupId, document.id)); setHistory(null); })}>Refresh</Button>
            </div>
            <DocumentMarkdown text={document.body} onOpenDocument={(id) => { if (!busy) setSelectedId(id); }} className="!mx-0 !max-w-none" />
            {history ? <section className="space-y-2 border-t border-line pt-3" data-testid="group-document-history-view">
              <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-xs font-semibold text-mist">Earlier revisions</h4><Button variant="ghost" className="text-xs" disabled={busy} onClick={() => setHistory(null)}>Done</Button></div>
              {history.length === 0 ? <p className="text-xs text-mist">No earlier revisions.</p> : history.map((revision) => <details className="rounded-xl border border-line p-3" key={revision.revision}>
                <summary className="cursor-pointer text-xs text-mist">Revision {revision.revision} · {revision.author}</summary>
                <h5 className="my-2 break-words text-sm text-snow">{revision.title}</h5>
                <DocumentMarkdown text={revision.body} className="!mx-0 !max-w-none" />
                <Button className="mt-2 whitespace-normal text-xs" disabled={busy} data-testid="group-document-restore" onClick={() => void run(async () => {
                  setDocument(await api.restore(groupId, document.id, revision.revision, document.revision));
                  setHistory(null); setRefreshKey((key) => key + 1);
                })}>Restore as a new revision</Button>
              </details>)}
            </section> : null}
          </article> : !error ? <Empty>Opening document...</Empty> : null}
        </> : null}
        {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
      </div>
    </aside>
  );
}
