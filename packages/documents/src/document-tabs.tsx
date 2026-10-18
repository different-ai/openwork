import { useRef, useState } from "react"
import { FileText, X } from "lucide-react"
import type { DocumentItem } from "./index"

export type DocumentTabControls = { requestClose(): void; checkAccess(): Promise<void> }
export type DocumentTabControlsChange = (id: string, controls: DocumentTabControls | null) => void

/** Reorders navigation only. The host keeps mounted editors in their original order. */
export function DocumentTabs({ items, activeId, dirtyIds, busyIds, onSelect, onClose, onReorder }: {
  items: DocumentItem[]; activeId: string; dirtyIds: ReadonlySet<string>; busyIds: ReadonlySet<string>
  onSelect(id: string): void; onClose(id: string): void; onReorder(ids: string[]): void
}) {
  const dragged = useRef<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [target, setTarget] = useState<{ id: string; edge: "before" | "after" } | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const finishDrag = () => { dragged.current = null; setDragging(null); setTarget(null) }
  const move = (id: string, index: number) => {
    const previous = items.findIndex(item => item.id === id)
    if (previous < 0) return
    const next = items.filter(item => item.id !== id).map(item => item.id)
    const at = Math.max(0, Math.min(index, next.length))
    if (at === previous) return
    next.splice(at, 0, id)
    onReorder(next)
    setAnnouncement(`Moved ${items.find(item => item.id === id)?.name ?? "document"} to position ${at + 1} of ${next.length}.`)
  }
  return <nav className="ow-document-tabs" aria-label="Open documents" onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget instanceof Node ? event.relatedTarget : null)) setTarget(null) }}>
    <button type="button" className="ow-document-tab-files" aria-current={activeId === "files" ? "page" : undefined} onClick={() => onSelect("files")}>Files</button>
    {items.map((item, index) => <div key={item.id} className="ow-document-tab" data-document-id={item.id} data-active={activeId === item.id} data-dragging={dragging === item.id} data-drop={target?.id === item.id ? target.edge : undefined} onDragOver={event => {
      if (!dragged.current || dragged.current === item.id) return
      event.preventDefault(); event.dataTransfer.dropEffect = "move"
      const bounds = event.currentTarget.getBoundingClientRect()
      const edge = event.clientX < bounds.left + bounds.width / 2 ? "before" : "after"
      setTarget(current => current?.id === item.id && current.edge === edge ? current : { id: item.id, edge })
      const nav = event.currentTarget.parentElement
      const navBounds = nav?.getBoundingClientRect()
      if (nav && navBounds) { if (event.clientX < navBounds.left + 30) nav.scrollLeft -= 20; else if (event.clientX > navBounds.right - 30) nav.scrollLeft += 20 }
    }} onDrop={event => {
      const id = dragged.current
      if (!id || id === item.id || !items.some(item => item.id === id)) return
      event.preventDefault()
      const bounds = event.currentTarget.getBoundingClientRect()
      const after = event.clientX >= bounds.left + bounds.width / 2
      const others = items.filter(item => item.id !== id)
      move(id, others.findIndex(candidate => candidate.id === item.id) + (after ? 1 : 0))
      finishDrag()
    }}>
      <button type="button" className="ow-document-tab-open" draggable aria-label={`${item.name}${dirtyIds.has(item.id) ? ", unsaved changes" : ""}`} aria-current={activeId === item.id ? "page" : undefined} aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Delete" title={`${item.name}\nDrag to reorder, or use Alt+Shift+Left/Right`} onClick={() => onSelect(item.id)} onDragStart={event => {
        dragged.current = item.id; setDragging(item.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.id)
        if (event.currentTarget.parentElement) event.dataTransfer.setDragImage(event.currentTarget.parentElement, 20, 20)
      }} onDragEnd={finishDrag} onKeyDown={event => {
        if (event.altKey && event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
          event.preventDefault(); move(item.id, index + (event.key === "ArrowLeft" ? -1 : 1))
          const button = event.currentTarget; requestAnimationFrame(() => button.scrollIntoView({ block: "nearest", inline: "nearest" }))
        }
        else if (event.key === "Delete" && !busyIds.has(item.id)) { event.preventDefault(); onClose(item.id) }
      }}><FileText size={14} aria-hidden/><span className="ow-document-tab-name">{item.name}</span>{dirtyIds.has(item.id) && <span className="ow-document-tab-dirty" aria-hidden/>}</button>
      <button type="button" className="ow-document-tab-close" aria-label={`Close ${item.name}`} title={`Close ${item.name}`} disabled={busyIds.has(item.id)} onClick={() => onClose(item.id)}><X size={14} strokeWidth={1.5} aria-hidden/></button>
    </div>)}
    <span className="ow-documents-sr-only" aria-live="polite">{announcement}</span>
  </nav>
}
