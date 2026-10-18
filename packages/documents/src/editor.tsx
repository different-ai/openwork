"use client"

import { z } from "zod"
import { EditorActions } from "./editor-actions"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeft, ArrowRight, ExternalLink, Save, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { OfficeEditorTab } from "./office-editor"
import { officeMimeTypes } from "./office-engine"
import { columnLetters } from "@openwork/workbook"
import { DocumentsError, type DocumentItem } from "./index"
import type { DocumentSave, DocumentsEditor, EditorDocument, SpreadsheetDocument, TextDocument } from "./model"
import type { DocumentTabControlsChange } from "./document-tabs"

export function DocumentEditorTab(props: Parameters<typeof BasicDocumentEditorTab>[0]) {
  if (props.editor.office && officeMimeTypes.has(props.item.mimeType)) return <OfficeEditorTab {...props} editor={props.editor.office} />
  return <BasicDocumentEditorTab {...props} />
}

function BasicDocumentEditorTab({ toolbarHost, item, tabId = item.id, editor, enabled, active, scope, connectionsHref, onDirtyChange, onSavingChange, onControlsChange, onClose }: { toolbarHost?: HTMLElement | null; item: DocumentItem; tabId?: string; editor: DocumentsEditor; enabled: boolean; active: boolean; scope: readonly string[]; connectionsHref?: string | null; onDirtyChange?(id: string, dirty: boolean): void; onSavingChange?(id: string, saving: boolean): void; onResourceChange?(tabId: string, resource: DocumentItem): void; onControlsChange?: DocumentTabControlsChange; onClose(): void }) {
  const [sheetId, setSheetId] = useState<string>()
  const [startRow, setStartRow] = useState(1)
  const [connectionId, setConnectionId] = useState<string>()
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [formulas, setFormulas] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsConnection, setNeedsConnection] = useState(false)
  const [saved, setSaved] = useState(false)
  const [closing, setClosing] = useState(false)
  const dirty = Object.keys(draft).length > 0
  const closeAction = useRef<() => void>(() => {})
  closeAction.current = () => { if (!saving) { if (dirty) setClosing(true); else onClose() } }
  useEffect(() => {
    onControlsChange?.(tabId, { requestClose: () => closeAction.current() })
    return () => onControlsChange?.(tabId, null)
  }, [tabId, onControlsChange])
  useEffect(() => { onSavingChange?.(tabId, saving); return () => onSavingChange?.(tabId, false) }, [tabId, saving, onSavingChange])
  useEffect(() => { onDirtyChange?.(tabId, dirty); return () => onDirtyChange?.(tabId, false) }, [dirty, tabId, onDirtyChange])
  const query = useQuery({
    queryKey: ["documents", ...scope, "editor", tabId, item.id, sheetId, startRow, connectionId],
    queryFn: ({ signal }) => editor.open(item.id, { sheetId, startRow, connectionId }, signal),
    enabled: enabled && active,
    retry: false, gcTime: 0, staleTime: Infinity, refetchOnWindowFocus: false,
  })
  const data = query.data
  useEffect(() => { if (data && !connectionId) setConnectionId(data.connectionId) }, [data, connectionId])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])
  const change = (key: string, value: string, base: string) => {
    setSaved(false)
    setDraft(current => { const next = { ...current }; if (value === base) delete next[key]; else next[key] = value; return next })
  }
  const save = async () => {
    if (!data || !dirty || saving || !enabled) return
    let payload: DocumentSave
    const common = { revision: data.revision, connectionId: data.connectionId }
    if (data.kind === "spreadsheet") payload = { ...common, kind: "spreadsheet", sheetId: data.activeSheetId, changes: Object.entries(draft).map(([key, value]) => { const [row, column] = key.split(":").map(Number); return { row, column, value, formula: formulas.has(key) } }) }
    else if (data.kind === "document") payload = { ...common, kind: "document", changes: Object.entries(draft).map(([key, value]) => { const [sectionId, runId] = z.tuple([z.string(), z.string()]).parse(JSON.parse(key)); return { sectionId, runId, value } }) }
    else if (data.kind === "text") payload = { ...common, kind: "text", text: draft.text ?? data.text }
    else return
    setSaving(true); setError(null); setNeedsConnection(false)
    try {
      await editor.save(item.id, payload)
      // A save can have succeeded even if reloading fails; never retry the write automatically.
      setDraft({}); setFormulas(new Set()); setSaved(true)
      if (closing) onClose()
      else await query.refetch()
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't confirm the save. Check Drive before trying again."); setNeedsConnection(failure instanceof DocumentsError && failure.code === "needs_connection") }
    finally { setSaving(false) }
  }
  const readonly = !enabled || !data?.canEdit || saving
  return <section className="ow-document-editor" hidden={!active} aria-label={item.name}>
    <EditorActions active={active} host={toolbarHost}><span role="status">{saving ? "Saving to Drive…" : dirty ? "Unsaved changes" : saved ? "Saved to Drive" : data?.canEdit ? "Saved in Drive" : "Read-only"}</span>{item.openUrl && <a href={item.openUrl} target="_blank" rel="noopener noreferrer" aria-label="Open original in Drive"><ExternalLink size={16} /></a>}<button type="button" disabled={!dirty || readonly} onClick={() => void save()}><Save size={15} aria-hidden />Save to Drive</button>{!onControlsChange && <button type="button" aria-label={`Close ${item.name}`} disabled={saving} onClick={() => closeAction.current()}><X size={16} /></button>}</EditorActions>
    {closing && <div className="ow-editor-message" role="status">Keep changes to {item.name}?<button type="button" onClick={() => void save()} disabled={readonly}>Save and close</button><button type="button" onClick={() => setClosing(false)}>Keep editing</button><button type="button" onClick={onClose} disabled={saving}>Discard changes</button></div>}
    {!enabled ? <div className="ow-editor-message">Documents is off for this workspace. Your draft remains in this tab.</div>
      : query.isError ? <div className="ow-editor-message" role="status">{query.error instanceof Error ? query.error.message : "Couldn't open this document."}{connectionsHref && query.error instanceof DocumentsError && query.error.code === "needs_connection" && <a href={connectionsHref} target="_blank" rel="noopener noreferrer">Reconnect Google Drive</a>}<button type="button" onClick={() => void query.refetch()}>Try again</button></div>
      : !data ? <div className="ow-documents-skeleton" aria-busy="true" aria-label="Opening document"><div/><div/><div/></div>
      : <>{data.notice && <div className="ow-editor-message">{data.notice}</div>}{!data.canEdit && <div className="ow-editor-message">Read-only. Editing requires write access to this file and the connector's enabled write permission.</div>}{error && <div className="ow-editor-message" role="alert">{error}{needsConnection && connectionsHref && <a href={connectionsHref} target="_blank" rel="noopener noreferrer">Reconnect Google Drive</a>}<button type="button" disabled={saving} onClick={() => { setDraft({}); setFormulas(new Set()); setError(null); void query.refetch() }}>Reload latest and discard edits</button></div>}
        {data.kind === "spreadsheet" ? <Spreadsheet data={data} draft={draft} formulas={formulas} setFormulas={setFormulas} readonly={readonly} change={change} onSheet={id => { setSheetId(id); setStartRow(1); setSaved(false) }} onPage={row => { setStartRow(row); setSaved(false) }} dirty={dirty} />
          : data.kind === "document" ? <RichDocument data={data} draft={draft} readonly={readonly} change={change} />
          : data.kind === "text" ? <textarea className="ow-editor-plain" aria-label="Document text" value={draft.text ?? data.text} readOnly={readonly} onChange={event => change("text", event.target.value, data.text)} />
          : <DocumentPreview data={data} editor={editor} item={item} />}
      </>}
  </section>
}
function Spreadsheet({ data, draft, formulas, setFormulas, readonly, change, onSheet, onPage, dirty }: { data: SpreadsheetDocument; draft: Record<string, string>; formulas: Set<string>; setFormulas(value: Set<string>): void; readonly: boolean; change(key: string, value: string, base: string): void; onSheet(id: string): void; onPage(row: number): void; dirty: boolean }) {
  const [selected, setSelected] = useState("1:1")
  const cells = useMemo(() => new Map(data.cells.map(cell => [`${cell.row}:${cell.column}`, cell])), [data.cells])
  const current = cells.get(selected)
  const original = current?.formula ? `=${current.formula}` : current?.text ?? ""
  const cellLabel = (() => { const [row, column] = selected.split(":").map(Number); return `${columnLetters(column)}${row}` })()
  const toggleFormula = (checked: boolean) => { const next = new Set(formulas); if (checked) next.add(selected); else next.delete(selected); setFormulas(next) }
  return <div className="ow-editor-spreadsheet">
    <div className="ow-editor-formula"><label>{cellLabel}<input aria-label={`Edit ${cellLabel}`} value={draft[selected] ?? original} readOnly={readonly} onChange={event => change(selected, event.target.value, original)} /></label><label><input type="checkbox" checked={formulas.has(selected)} disabled={readonly || draft[selected] === undefined} onChange={event => toggleFormula(event.target.checked)} />Save as formula</label></div>
    <div className="ow-editor-grid-scroll"><table className="ow-editor-grid"><thead><tr><th aria-label="Row"/>{Array.from({ length: Math.min(26, data.sheets.find(sheet => sheet.id === data.activeSheetId)?.columns ?? 26) }, (_, column) => <th scope="col" key={column}>{columnLetters(column + 1)}</th>)}</tr></thead><tbody>{Array.from({ length: data.endRow - data.startRow + 1 }, (_, offset) => { const row = data.startRow + offset; return <tr key={row}><th scope="row">{row}</th>{Array.from({ length: Math.min(26, data.sheets.find(sheet => sheet.id === data.activeSheetId)?.columns ?? 26) }, (_, index) => { const column = index + 1; const key = `${row}:${column}`; const cell = cells.get(key); const base = cell?.formula ? `=${cell.formula}` : cell?.text ?? ""; return <td key={column} data-active={selected === key}><input aria-label={`${columnLetters(column)}${row}`} value={draft[key] ?? base} readOnly={readonly} onFocus={() => setSelected(key)} onChange={event => change(key, event.target.value, base)} onPaste={event => {
      const text = event.clipboardData.getData("text/plain")
      if (readonly || !/[\t\n]/.test(text)) return
      event.preventDefault()
      const rows = text.replace(/\r/g, "").replace(/\n$/, "").split("\n").map(line => line.split("\t"))
      if (rows.reduce((count, values) => count + values.length, 0) > 500 || row + rows.length - 1 > data.endRow || column + Math.max(...rows.map(values => values.length)) - 1 > Math.min(26, data.sheets.find(sheet => sheet.id === data.activeSheetId)?.columns ?? 26)) return
      rows.forEach((values, rowOffset) => values.forEach((value, columnOffset) => { const target = `${row + rowOffset}:${column + columnOffset}`; const original = cells.get(target); change(target, value, original?.formula ? `=${original.formula}` : original?.text ?? "") }))
    }} onKeyDown={event => {
      const directions: Record<string, [number, number]> = { ArrowDown: [1,0], ArrowUp: [-1,0] }
      const direction = directions[event.key]
      if (!direction || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
      const next = document.querySelector<HTMLInputElement>(`.ow-document-editor:not([hidden]) input[aria-label="${columnLetters(column + direction[1])}${row + direction[0]}"]`)
      if (next) { event.preventDefault(); next.focus() }
    }} /></td> })}</tr> })}</tbody></table></div>
    <footer className="ow-editor-sheets"><nav aria-label="Worksheets">{data.sheets.map(sheet => <button type="button" key={sheet.id} aria-current={sheet.id === data.activeSheetId ? "page" : undefined} disabled={dirty || readonly && sheet.id === data.activeSheetId} onClick={() => onSheet(sheet.id)}>{sheet.name}</button>)}</nav><button type="button" aria-label="Previous rows" disabled={dirty || data.startRow === 1} onClick={() => onPage(Math.max(1, data.startRow - 50))}><ArrowLeft size={14} /></button><span>Rows {data.startRow}–{data.endRow}</span><button type="button" aria-label="Next rows" disabled={dirty || data.endRow >= (data.sheets.find(s => s.id === data.activeSheetId)?.rows ?? 1000)} onClick={() => onPage(data.startRow + 50)}><ArrowRight size={14}/></button></footer>
    {dirty && <div className="ow-editor-message">Save these edits before changing worksheets or rows. Values are literal unless you choose “Save as formula”.</div>}
  </div>
}
function RichDocument({ data, draft, readonly, change }: { data: TextDocument; draft: Record<string, string>; readonly: boolean; change(key: string, value: string, base: string): void }) {
  return <div className="ow-editor-pages">{data.sections.map(section => <article className="ow-editor-paper" key={section.id} aria-label={section.name}>{data.sections.length > 1 && <h2>{section.name}</h2>}{section.paragraphs.map(paragraph => <p key={paragraph.id} className={paragraph.heading ? "ow-editor-heading" : undefined}>{paragraph.runs.map(run => { const key = JSON.stringify([section.id, run.id]); return <span key={key} role="textbox" aria-label={`Edit text: ${run.text.slice(0, 40) || "Empty paragraph"}`} contentEditable={!readonly} suppressContentEditableWarning style={{ fontWeight: run.bold ? 600 : undefined, fontStyle: run.italic ? "italic" : undefined, textDecoration: run.underline ? "underline" : undefined }} onBlur={event => change(key, event.currentTarget.innerText, run.text)} onInput={event => change(key, event.currentTarget.innerText, run.text)} onPaste={event => {
      event.preventDefault()
      const text = event.clipboardData.getData("text/plain").slice(0, 32_767)
      const selection = window.getSelection()
      if (!selection?.rangeCount || !event.currentTarget.contains(selection.anchorNode) || !event.currentTarget.contains(selection.focusNode)) return
      const range = selection.getRangeAt(0); range.deleteContents(); const node = document.createTextNode(text); range.insertNode(node); range.setStartAfter(node); range.collapse(true); selection.removeAllRanges(); selection.addRange(range)
      change(key, event.currentTarget.innerText, run.text)
    }} onDrop={event => event.preventDefault()}>{run.text}</span> })}</p>)}</article>)}</div>
}
function DocumentPreview({ data, editor, item }: { data: Extract<EditorDocument, { kind: "preview" }>; editor: DocumentsEditor; item: DocumentItem }) {
  const url = `${editor.contentUrl(item.id)}?connectionId=${encodeURIComponent(data.connectionId)}`
  if (data.mimeType === "application/pdf") return <iframe className="ow-editor-preview" src={url} title={item.name} sandbox="allow-same-origin" />
  if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(data.mimeType)) return <div className="ow-editor-image"><img src={url} alt={item.name} /></div>
  return <div className="ow-documents-state"><p>This format needs its original editor.</p>{item.openUrl && <a href={item.openUrl} target="_blank" rel="noopener noreferrer">Open in Drive</a>}</div>
}
