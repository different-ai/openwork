"use client"

import { ExternalLink, Save, X } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { z } from "zod"
import type { DocumentItem } from "./index"
import { officeFormats, savedOfficeDocument, type OfficeEditor } from "./office-engine"
import { EditorActions } from "./editor-actions"
import type { DocumentTabControlsChange } from "./document-tabs"
import { collaboraWorkspaceUrl, useCollaboraController } from "./collabora-controller"
import { DocumentToolbar } from "./document-toolbar"

const messageSchema = z.object({ MessageId: z.string(), Values: z.object({ Status: z.string().optional(), Modified: z.boolean().optional(), success: z.boolean().optional(), result: z.string().optional() }).passthrough().optional() })
export function OfficeEditorTab({ item, editor, enabled, active, scope, toolbarHost, onDirtyChange, onSavingChange, onResourceChange, onControlsChange, onClose }: { item: DocumentItem; editor: OfficeEditor; enabled: boolean; active: boolean; scope: readonly string[]; toolbarHost?: HTMLElement | null; onDirtyChange?(id: string, dirty: boolean): void; onSavingChange?(id: string, saving: boolean): void; onResourceChange?(tabId: string, resource: DocumentItem): void; onControlsChange?: DocumentTabControlsChange; onClose(): void }) {
  const [dirty, setDirty] = useState(false)
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string>()
  const [error, setError] = useState<string>()
  const [closing, setClosing] = useState(false)
  const accessCheck = useRef<() => Promise<void>>(async () => { throw new Error("The document is not open.") })
  const closeAction = useRef<() => void>(() => {})
  closeAction.current = () => { if (!saving) { if (dirty) setClosing(true); else onClose() } }
  useEffect(() => {
    onControlsChange?.(item.id, { requestClose: () => closeAction.current(), checkAccess: () => accessCheck.current() })
    return () => onControlsChange?.(item.id, null)
  }, [item.id, onControlsChange])
  useEffect(() => { onSavingChange?.(item.id, saving); return () => onSavingChange?.(item.id, false) }, [item.id, saving, onSavingChange])
  const changes = useRef(0)
  const frame = useRef<HTMLIFrameElement>(null)
  const form = useRef<HTMLFormElement>(null)
  const frameName = `office-${useId().replace(/:/g, "")}`
  const pending = useRef<{ resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>(undefined)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (pending.current) { clearTimeout(pending.current.timer); pending.current.reject(new Error("The editor was closed.")); pending.current = undefined } } }, [])
  const query = useQuery({ queryKey: ["documents", ...scope, "office", item.id], queryFn: ({ signal }) => editor.open(item.id, signal), enabled: enabled && active, retry: false, gcTime: 0, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false })
  const session = query.data
  accessCheck.current = async () => {
    if (session) { await editor.status(item.id, session.id); return }
    // An initial open may have failed during auth. Rechecking must establish the
    // missing session explicitly, not deadlock every other retained document.
    const result = await query.refetch({ throwOnError: true })
    if (!result.data) throw new Error("The document hasn't opened yet.")
  }
  const formatLabel = session ? officeFormats[session.fileType].label : "document"
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    clearTimeout(closeTimer.current)
    if (!session) return
    return () => { closeTimer.current = setTimeout(() => { void editor.close(item.id, session.id).catch(() => {}) }, 0) }
  }, [editor, item.id, session])
  useEffect(() => { onDirtyChange?.(item.id, dirty); return () => onDirtyChange?.(item.id, false) }, [dirty, item.id, onDirtyChange])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])
  useEffect(() => {
    if (!session) return
    const origin = new URL(session.serverUrl).origin
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin) return
      let input: unknown = event.data
      if (typeof input === "string") { try { input = JSON.parse(input) } catch { return } }
      const parsed = messageSchema.safeParse(input); if (!parsed.success) return
      const message = parsed.data
      if (message.MessageId === "App_LoadingStatus") {
        if (message.Values?.Status === "Frame_Ready") frame.current?.contentWindow?.postMessage(JSON.stringify({ MessageId: "Host_PostmessageReady", SendTime: Date.now(), Values: {} }), origin)
        if (message.Values?.Status === "Document_Loaded") setReady(true)
      }
      if (message.MessageId === "Doc_ModifiedStatus" && message.Values?.Modified) { changes.current++; setDirty(true) }
      if (message.MessageId === "Action_Save_Resp" && pending.current) {
        const request = pending.current; pending.current = undefined; clearTimeout(request.timer)
        if (message.Values?.success === true || message.Values?.result === "unmodified") request.resolve()
        else request.reject(new Error("The editor could not save the snapshot. Keep this tab open and try again."))
      }
    }
    window.addEventListener("message", receive)
    // Credentials are POSTed into the trusted editor frame, never included in its URL.
    form.current?.submit()
    return () => window.removeEventListener("message", receive)
  }, [session])
  const [now, setNow] = useState(Date.now)
  useEffect(() => { if (!session) return; const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer) }, [session])
  const expired = !!session && Date.parse(session.expiresAt) <= now
  const controller = useCollaboraController({ frame, session, ready: ready && enabled && !saving && !expired, canEdit: !!session?.canEdit && enabled && !saving && !expired, active })
  const save = async (closeAfter = false) => {
    if (!session || !enabled || saving || expired || !ready || !session.canEdit) return
    const generation = changes.current; setSaving(true); setError(undefined)
    try {
      const saveRequestId = crypto.randomUUID()
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { pending.current = undefined; reject(new Error("The editor hasn't confirmed your changes yet. Keep this tab open and try Save to Drive again.")) }, 45_000)
        pending.current = { resolve, reject, timer }
        frame.current?.contentWindow?.postMessage(JSON.stringify({ MessageId: "Action_Save", SendTime: Date.now(), Values: { DontTerminateEdit: true, DontSaveIfUnmodified: false, Notify: true, ExtendedData: saveRequestId } }), new URL(session.serverUrl).origin)
      })
      // The engine's local save acknowledgement can precede its WOPI upload.
      // A forced snapshot must arrive before committing, even after an autosave.
      let status = await editor.status(item.id, session.id)
      const until = Date.now() + 20_000
      while (status.saveRequestId !== saveRequestId && Date.now() < until && mounted.current) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        status = await editor.status(item.id, session.id)
      }
      if (!mounted.current) return
      if (status.saveRequestId !== saveRequestId) throw new Error("Your latest changes haven't reached the document service. Keep this tab open and try Save to Drive again.")
      const result = await editor.save(item.id, session.id, status.draftVersion)
      if (!mounted.current) return
      setSaved(result.fileId)
      onResourceChange?.(item.id, savedOfficeDocument(item, session.fileType, session.saveAsCopy, result.fileId))
      if (generation === changes.current) { setDirty(false); setClosing(false); if (closeAfter) onClose() }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : "The save was not confirmed. Check Drive before trying again.") }
    finally { if (mounted.current) setSaving(false) }
  }
  const status = saving ? "Saving to Drive…" : dirty ? "Unsaved to Drive" : saved ? "Saved to Drive" : !session?.canEdit && session ? "Read-only" : ""
  return <section className="ow-document-editor ow-office-editor" hidden={!active} aria-label={item.name}>
    <EditorActions active={active} host={toolbarHost}><span role="status">{status}</span>{item.openUrl && <a href={item.openUrl} target="_blank" rel="noopener noreferrer" aria-label="Open original in Drive"><ExternalLink size={16}/></a>}<button type="button" disabled={!enabled || !session?.canEdit || !ready || saving || expired || (!dirty && (!session.saveAsCopy || !!saved))} onClick={() => void save()}><Save size={15}/>{session?.saveAsCopy && !saved ? `Save ${formatLabel} copy to Drive` : "Save to Drive"}</button>{!onControlsChange && <button type="button" aria-label={`Close ${item.name}`} disabled={saving} onClick={() => closeAction.current()}><X size={16}/></button>}</EditorActions>
    {closing && <div className="ow-editor-message" role="status">This file has changes that haven't been saved to Drive.<button type="button" disabled={saving || !enabled || !ready || expired || !session?.canEdit} onClick={() => void save(true)}>Save and close</button><button type="button" disabled={saving} onClick={() => setClosing(false)}>Keep editing</button><button type="button" disabled={saving} onClick={onClose}>Close without saving</button></div>}
    {session?.saveAsCopy && <div className="ow-editor-message">{saved ? "Your copy is saved in My Drive. Further saves update that copy." : `You’re editing a ${formatLabel} copy. Save creates a new file in My Drive; the Google original stays unchanged.`}{saved && <a href={`https://drive.google.com/file/d/${encodeURIComponent(saved)}/view`} target="_blank" rel="noopener noreferrer">Open saved copy</a>}</div>}
    {!enabled && <div className="ow-editor-message">Documents is off for this workspace.</div>}
    {(error || query.isError || expired) && <div className="ow-editor-message" role="alert">{expired ? "This editing session expired. Download your changes from the editor before closing it." : error ?? (query.error instanceof Error ? query.error.message : "Couldn't open the full editor.")}{!session && item.openUrl && <a href={item.openUrl} target="_blank" rel="noopener noreferrer">Open in Drive</a>}</div>}
    {!session && query.isPending && <div className="ow-documents-skeleton" aria-label="Opening full editor" aria-busy="true"><div/><div/><div/></div>}
    {session && <DocumentToolbar controller={controller}/>}
    {session && <div className="ow-office-canvas" inert={saving || !enabled} aria-busy={saving}>
      <form ref={form} method="post" action={collaboraWorkspaceUrl(session.editorUrl)} target={frameName} hidden><input type="hidden" name="access_token" value={session.accessToken}/><input type="hidden" name="access_token_ttl" value={Date.parse(session.expiresAt)}/></form>
      <iframe ref={frame} name={frameName} title={`Edit ${item.name}`} className="ow-office-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-modals" allow="clipboard-read; clipboard-write" allowFullScreen referrerPolicy="no-referrer"/>
    </div>}
  </section>
}
