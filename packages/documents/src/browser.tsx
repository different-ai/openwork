"use client"

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query"
import { Clock, ChevronRight, ExternalLink, FileText, FileSpreadsheet, Image, Presentation, Folder, Grid2X2, Info, List, Lock, RefreshCw, Search, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { DocumentEditorTab } from "./editor"
import { DocumentTabs, type DocumentTabControls, type DocumentTabControlsChange } from "./document-tabs"
import type { DocumentsEditor } from "./model"
import { DocumentsError, documentType, type DocumentItem, type DocumentsProvider, type DocumentsViewContext, type DocumentOpenRequest } from "./index"

export type DocumentsBrowserProps = {
  provider: DocumentsProvider
  editor?: DocumentsEditor
  /** Include the authenticated organization and person. Never reuse a cache across identities. */
  scope: readonly string[]
  enabled: boolean
  connectionsHref?: string | null
  onDirtyChange?(dirty: boolean): void
  onContextChange?(context: DocumentsViewContext | null): void
  openDocument?: DocumentOpenRequest
}

function date(value: string | null) {
  if (!value) return "—"
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? "—" : parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}
function size(value: number | null) {
  if (value === null) return "—"
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 ** 2).toFixed(1)} MB`
}
function ItemIcon({ item }: { item: DocumentItem }) {
  const type = documentType(item)
  const Icon = item.kind === "folder" ? Folder : /Sheets|Excel|CSV|spreadsheet/.test(type) ? FileSpreadsheet : /Slides|PowerPoint|presentation/.test(type) ? Presentation : type === "Image" ? Image : FileText
  return <Icon className="ow-documents-item-icon" data-kind={type} size={20} strokeWidth={1.5} aria-hidden />
}

/** A host-independent browser; providers own metadata reads and safe file-opening URLs. */
export function DocumentsBrowser({ provider, editor, scope, enabled, connectionsHref, onDirtyChange, onContextChange, openDocument }: DocumentsBrowserProps) {
  const queryClient = useQueryClient()
  const scopeKey = JSON.stringify(scope)
  const [resources, setResources] = useState<ReadonlyMap<string, DocumentItem>>(new Map())
  const resourceChanged = useCallback((id: string, item: DocumentItem) => setResources(current => new Map(current).set(id, item)), [])
  const dirtyTabs = useRef(new Set<string>())
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(new Set())
  const updateDirty = useCallback((id: string, dirty: boolean) => {
    if (dirtyTabs.current.has(id) === dirty) return
    if (dirty) dirtyTabs.current.add(id); else dirtyTabs.current.delete(id)
    setDirtyIds(new Set(dirtyTabs.current))
    onDirtyChange?.(dirtyTabs.current.size > 0)
  }, [onDirtyChange])
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set())
  const updateSaving = useCallback((id: string, saving: boolean) => setBusyIds(current => {
    if (current.has(id) === saving) return current
    const next = new Set(current); if (saving) next.add(id); else next.delete(id)
    return next
  }), [])
  const closeControls = useRef(new Map<string, DocumentTabControls>())
  const registerControls = useCallback<DocumentTabControlsChange>((id, controls) => { if (controls) closeControls.current.set(id, controls); else closeControls.current.delete(id) }, [])
  const [view, setView] = useState<"recent" | "folder">("recent")
  // A tab's identity must survive a native Google source becoming a distinct Office copy.
  // item.id is the source used to create its editor session; resources holds its current file.
  const [opened, setOpened] = useState<{ id: string; item: DocumentItem }[]>([])
  // Reordering editor DOM nodes can reload an iframe. Only reorder navigation.
  const [tabOrder, setTabOrder] = useState<string[]>([])
  const tabOrderRef = useRef(tabOrder)
  tabOrderRef.current = tabOrder
  const tabsRow = useRef<HTMLDivElement>(null)
  const orderedTabs = tabOrder.flatMap(id => { const item = opened.find(file => file.id === id); return item ? [{ ...(resources.get(id) ?? item.item), id }] : [] })
  const [activeTab, setActiveTab] = useState("files")
  const activeTabRef = useRef(activeTab)
  activeTabRef.current = activeTab
  const [actionsHost, setActionsHost] = useState<HTMLDivElement | null>(null)
  const [folders, setFolders] = useState([{ id: "root", name: provider.rootLabel }])
  const [draft, setDraft] = useState("")
  const [search, setSearch] = useState("")
  const [layout, setLayout] = useState<"list" | "grid">("list")
  const [selected, setSelected] = useState<DocumentItem | null>(null)
  const [order, setOrder] = useState<"recent" | "name" | "modified">("recent")
  const folder = view === "recent" ? { id: "recent", name: "Recent" } : folders[folders.length - 1]!
  const query = useInfiniteQuery({
    queryKey: ["documents", ...scope, provider.id, folder.id, search],
    queryFn: ({ pageParam, signal }) => provider.list({ view, folderId: view === "recent" ? "root" : folder.id, query: search, cursor: pageParam || undefined, signal }),
    initialPageParam: "",
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
    gcTime: 0,
  })
  const recent = useQuery({
    queryKey: ["documents", ...scope, provider.id, "recent-sidebar"],
    queryFn: ({ signal }) => provider.list({ view: "recent", folderId: "root", query: "", signal }),
    enabled: enabled && (view !== "recent" || !!search), retry: false, gcTime: 0, staleTime: 60_000,
    refetchOnWindowFocus: true,
  })
  const recentItems = view === "recent" && !search
    ? query.isError ? [] : query.data?.pages[0]?.items ?? []
    : recent.isError ? [] : recent.data?.items ?? []
  const items = useMemo(() => {
    const unique = new Map<string, DocumentItem>()
    for (const page of query.data?.pages ?? []) for (const item of page.items) unique.set(item.id, item)
    return [...unique.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1
      if (order === "recent") return 0
      if (order === "modified") return (Date.parse(b.modifiedTime ?? "") || 0) - (Date.parse(a.modifiedTime ?? "") || 0)
      return a.name.localeCompare(b.name, undefined, { numeric: true })
    })
  }, [query.data, order])
  const navigate = (index: number) => { setView("folder"); setActiveTab("files"); setOrder("name"); setFolders(current => current.slice(0, index + 1)); setSelected(null); setSearch(""); setDraft("") }
  const open = (item: DocumentItem) => {
    if (item.kind === "folder") { setView("folder"); setActiveTab("files"); setOrder("name"); setFolders(current => [...(view === "recent" ? [{ id: "root", name: provider.rootLabel }] : current), { id: item.id, name: item.name }]); setSearch(""); setDraft(""); setSelected(null) }
    else if (editor) {
      const existing = opened.find(tab => (resources.get(tab.id) ?? tab.item).id === item.id)
      if (existing) { setActiveTab(existing.id); return }
      const id = crypto.randomUUID()
      setOpened(current => [...current, { id, item }]); setTabOrder(current => [...current, id]); setActiveTab(id) }
    else setSelected(item)
  }
  const requested = useQuery({
    queryKey: ["documents", ...scope, provider.id, "open", openDocument?.requestId, openDocument?.fileId],
    queryFn: ({ signal }) => {
      if (!provider.get || !openDocument) throw new Error("This document provider cannot open links.")
      return provider.get(openDocument.fileId, signal)
    },
    enabled: enabled && !!openDocument, retry: false, gcTime: 0,
    refetchOnWindowFocus: false,
  })
  const handled = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!enabled || !requested.data || !openDocument || handled.current === openDocument.requestId) return
    handled.current = openDocument.requestId
    open(requested.data)
  })
  const activeItem = opened.find(item => item.id === activeTab)
  const activeFile = activeItem ? resources.get(activeTab) ?? activeItem.item : undefined
  const activeDirty = dirtyIds.has(activeTab)
  useEffect(() => {
    onContextChange?.(!enabled || query.isError || recent.error instanceof DocumentsError && [401, 403, 409].includes(recent.error.status) ? null : activeFile
      ? { kind: "file", item: activeFile, unsaved: activeDirty }
      : { kind: "files", view, folderId: folder.id, folderName: folder.name, query: search })
  }, [enabled, query.isError, recent.error, activeFile, activeDirty, view, folder.id, folder.name, search, onContextChange])
  const submit = (event: FormEvent) => { event.preventDefault(); setSearch(draft.trim()); setSelected(null) }
  const requestClose = (id: string) => {
    if (busyIds.has(id)) return
    if (dirtyTabs.current.has(id)) setActiveTab(id)
    closeControls.current.get(id)?.requestClose()
  }
  const close = (id: string) => {
    const order = tabOrderRef.current
    const index = order.indexOf(id)
    const neighbor = order[index + 1] ?? order[index - 1] ?? "files"
    const tab = tabsRow.current?.querySelector(`[data-document-id="${CSS.escape(id)}"]`)
    const restoreFocus = activeTabRef.current === id || !!tab?.contains(document.activeElement)
    setActiveTab(current => current === id ? neighbor : current)
    setOpened(current => current.filter(item => item.id !== id))
    setResources(current => { const next = new Map(current); next.delete(id); return next })
    setTabOrder(current => current.filter(tab => tab !== id))
    if (restoreFocus) requestAnimationFrame(() => tabsRow.current?.querySelector<HTMLButtonElement>(neighbor === "files" ? ".ow-document-tab-files" : `[data-document-id="${CSS.escape(neighbor)}"] .ow-document-tab-open`)?.focus())
    void query.refetch(); void recent.refetch()
  }
  const needsConnection = query.error instanceof DocumentsError && query.error.code === "needs_connection"
  const flagOff = query.error instanceof DocumentsError && ["workbot_documents_not_enabled", "feature_disabled"].includes(query.error.code)
  const blocked = query.error instanceof DocumentsError && [401, 403, 409].includes(query.error.status)
  const accessLost = blocked && !flagOff || recent.error instanceof DocumentsError && [401, 403, 409].includes(recent.error.status) && !["feature_disabled", "workbot_documents_not_enabled"].includes(recent.error.code)
  useEffect(() => {
    if (!accessLost) return
    setOpened([]); setResources(new Map()); setTabOrder([]); setActiveTab("files"); setSelected(null)
    dirtyTabs.current.clear(); setDirtyIds(new Set()); setBusyIds(new Set()); closeControls.current.clear()
    onDirtyChange?.(false)
    queryClient.removeQueries({ predicate: entry => entry.queryKey[0] === "documents"
      && JSON.stringify(entry.queryKey.slice(1, scope.length + 1)) === scopeKey
      && ["editor", "office", "open"].includes(String(entry.queryKey[scope.length + 1])) })
  }, [accessLost, queryClient, scopeKey, scope.length, onDirtyChange])
  // A failed revalidation must not leave a previously authorized file list or detail on screen.
  const visible = enabled && !query.isError && !accessLost
  return <section className="ow-documents" aria-label="Documents">
    <aside className="ow-documents-sidebar">
      <div className="ow-documents-source">Documents</div>
      <button type="button" className="ow-documents-location" aria-current={activeTab === "files" && view === "recent" ? "page" : undefined} onClick={() => { setView("recent"); setActiveTab("files"); setSearch(""); setDraft(""); setOrder("recent") }}><Clock size={16} strokeWidth={1.5} aria-hidden />Recent</button>
      <button type="button" className="ow-documents-location" aria-current={activeTab === "files" && view === "folder" ? "page" : undefined} onClick={() => navigate(0)}><Folder size={16} strokeWidth={1.5} aria-hidden />{provider.rootLabel}</button>
      <h2 className="ow-documents-recent-heading">Recent documents</h2>
      {visible && recentItems.slice(0, 8).map(item => <button type="button" className="ow-documents-recent-file" key={item.id} onClick={() => open(item)}><ItemIcon item={item} /><span>{item.name}</span></button>)}
    </aside>
    <div className="ow-documents-workspace">
      <div className="ow-document-tabs-row" ref={tabsRow}><DocumentTabs items={accessLost ? [] : orderedTabs} activeId={activeTab} dirtyIds={dirtyIds} busyIds={busyIds} onSelect={setActiveTab} onClose={requestClose} onReorder={setTabOrder}/><div className="ow-document-actions" ref={setActionsHost}/></div>
    {enabled && openDocument && requested.isError && <div className="ow-documents-notice" role="status">Couldn't open this document. Check your Drive connection and access. <button type="button" onClick={() => void requested.refetch()}>Try again</button></div>}
    <div className="ow-documents-main" hidden={activeTab !== "files"}>
      <header className="ow-documents-toolbar">
        <form onSubmit={submit} role="search" className="ow-documents-search"><Search size={16} strokeWidth={1.5} aria-hidden /><input aria-label={`Search ${folder.name}`} placeholder={`Search in ${folder.name}`} value={draft} maxLength={500} onChange={event => setDraft(event.target.value)} /><button type="submit">Search</button></form>
        <button type="button" title="Refresh documents" aria-label="Refresh documents" disabled={!enabled || query.isFetching} onClick={() => { void query.refetch(); void recent.refetch() }}><RefreshCw size={16} strokeWidth={1.5} /></button>
        <div className="ow-documents-layout" role="group" aria-label="Document view"><button type="button" aria-label="List view" aria-pressed={layout === "list"} onClick={() => setLayout("list")}><List size={16} strokeWidth={1.5} /></button><button type="button" aria-label="Grid view" aria-pressed={layout === "grid"} onClick={() => setLayout("grid")}><Grid2X2 size={16} strokeWidth={1.5} /></button></div>
      </header>
      <div className="ow-documents-heading"><nav aria-label="Folder breadcrumbs">{(view === "recent" ? [{ id: "recent", name: "Recent" }] : folders).map((entry, index) => <span key={`${entry.id}-${index}`}>{index > 0 && <ChevronRight size={14} aria-hidden />}<button type="button" onClick={() => view === "recent" ? setActiveTab("files") : navigate(index)} aria-current={index === folders.length - 1 ? "location" : undefined}>{entry.name}</button></span>)}</nav><label>Sort by <select aria-label="Sort documents" value={order} onChange={event => setOrder(event.target.value === "modified" ? "modified" : event.target.value === "recent" ? "recent" : "name")}><option value="recent">Drive order</option><option value="name">Name</option><option value="modified">Last modified</option></select></label></div>
      {search && <div className="ow-documents-notice">Results for “{search}” <button type="button" onClick={() => { setDraft(""); setSearch("") }}>Clear search</button></div>}
      {!enabled ? <div className="ow-documents-state"><Lock size={20} strokeWidth={1.5} /><p>Documents is off for your workspace. An admin can turn it on.</p></div>
        : query.isError || accessLost ? <div className="ow-documents-state" role="status">{blocked && <Lock size={20} strokeWidth={1.5} />}<p>{flagOff ? "Documents is off for your workspace. An admin can turn it on." : needsConnection ? "Connect Google Drive to browse and open your documents. Drive read permission is required." : blocked ? "Your workspace blocks access to these documents. An admin can review the connection." : "Couldn't load your documents."}</p>{needsConnection && connectionsHref && <a href={connectionsHref} target="_blank" rel="noopener noreferrer">Connect Google Drive</a>}<button type="button" onClick={() => { void query.refetch(); void recent.refetch() }}>Try again</button></div>
        : query.isPending ? <div className="ow-documents-skeleton" aria-label="Loading documents" aria-busy="true">{Array.from({ length: 8 }, (_, index) => <div key={index} />)}</div>
        : <><div className="ow-documents-content">
          <div className="ow-documents-listing">
            {layout === "list" ? <table><thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Last modified</th><th scope="col">Size</th></tr></thead><tbody>{items.map(item => <tr key={item.id} data-selected={selected?.id === item.id}><td><button type="button" className="ow-documents-file" onClick={() => open(item)}><ItemIcon item={item} /><span>{item.name}</span></button></td><td>{documentType(item)}</td><td>{date(item.modifiedTime)}</td><td>{size(item.size)}</td></tr>)}</tbody></table>
              : <div className="ow-documents-grid">{items.map(item => <button type="button" key={item.id} className="ow-documents-tile" data-selected={selected?.id === item.id} onClick={() => open(item)}><ItemIcon item={item} /><strong>{item.name}</strong><span>{documentType(item)}</span></button>)}</div>}
            {items.length === 0 && <div className="ow-documents-state"><Folder size={24} strokeWidth={1.5} /><p>{search ? "No documents match your search." : view === "recent" ? "No recent documents in Drive." : "This folder is empty."}</p></div>}
            {query.hasNextPage && <button type="button" className="ow-documents-more" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load more</button>}
            {query.data?.pages.some(page => page.incomplete) && <p className="ow-documents-notice" role="status">Google couldn't search every drive. Some files may be missing.</p>}
          </div>
          {visible && selected && <aside className="ow-documents-detail" aria-label="Document details"><div className="ow-documents-detail-heading"><Info size={16} aria-hidden /><span>Details</span><button type="button" aria-label="Close document details" onClick={() => setSelected(null)}><X size={16} /></button></div><ItemIcon item={selected} /><h2>{selected.name}</h2><dl><dt>Type</dt><dd>{documentType(selected)}</dd><dt>Last modified</dt><dd>{date(selected.modifiedTime)}</dd><dt>Size</dt><dd>{size(selected.size)}</dd></dl>{selected.openUrl ? <a className="ow-documents-open" href={selected.openUrl} target="_blank" rel="noopener noreferrer">Open in {provider.label}<ExternalLink size={14} aria-hidden /></a> : <p>This file has no available link.</p>}</aside>}
        </div></>}
    </div>
    {editor && !accessLost && opened.map(tab => <DocumentEditorTab toolbarHost={actionsHost} key={tab.id} tabId={tab.id} item={tab.item} editor={editor} enabled={enabled} active={enabled && !query.isError && !recent.isError && activeTab === tab.id} scope={scope} connectionsHref={connectionsHref} onDirtyChange={updateDirty} onSavingChange={updateSaving} onResourceChange={resourceChanged} onControlsChange={registerControls} onClose={() => close(tab.id)} />)}
    </div>
  </section>
}

export { OfficeEditorTab } from "./office-editor"
export { DocumentToolbar, EditorToolbarButton, EditorToolbarMenu } from "./document-toolbar"
export type { EditorAction, EditorCommand, EditorController, EditorSelection } from "./editor-controller"
