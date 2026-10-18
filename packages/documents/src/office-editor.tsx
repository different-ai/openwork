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
export function OfficeEditorTab({ item, tabId = item.id, editor, enabled, active, scope, toolbarHost, onDirtyChange, onSavingChange, onResourceChange, onControlsChange, onClose }: { item: DocumentItem; tabId?: string; editor: OfficeEditor; enabled: boolean; active: boolean; scope: readonly string[]; toolbarHost?: HTMLElement | null; onDirtyChange?(id: string, dirty: boolean): void; onSavingChange?(id: string, saving: boolean): void; onResourceChange?(tabId: string, resource: DocumentItem): void; onControlsChange?: DocumentTabControlsChange; onClose(): void }) {
  const [dirty, setDirty] = useState(false)
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string>()
  const [error, setError] = useState<string>()
  const [unconfirmed, setUnconfirmed] = useState(false)
  const [closing, setClosing] = useState(false)
  const closeAction = useRef<() => void>(() => {})
  closeAction.current = () => { if (!saving) { if (dirty || unconfirmed) setClosing(true); else onClose() } }
  useEffect(() => {
    onControlsChange?.(tabId, { requestClose: () => closeAction.current() })
    return () => onControlsChange?.(tabId, null)
  }, [tabId, onControlsChange])
  useEffect(() => { onSavingChange?.(tabId, saving); return () => onSavingChange?.(tabId, false) }, [tabId, saving, onSavingChange])
  const changes = useRef(0)
  const frame = useRef<HTMLIFrameElement>(null)
  const form = useRef<HTMLFormElement>(null)
  const frameName = `office-${useId().replace(/:/g, "")}`
  const pending = useRef<{ resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>(undefined)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (pending.current) { clearTimeout(pending.current.timer); pending.current.reject(new Error("The editor was closed.")); pending.current = undefined } } }, [])
  const query = useQuery({ queryKey: ["documents", ...scope, "office", tabId, item.id], queryFn: ({ signal }) => editor.open(item.id, signal), enabled: enabled && active, retry: false, gcTime: 0, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false })
  const session = query.data
  const formatLabel = session ? officeFormats[session.fileType].label : "document"
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    clearTimeout(closeTimer.current)
    if (!session) return
    return () => { closeTimer.current = setTimeout(() => { void editor.close(item.id, session.id).catch(() => {}) }, 0) }
  }, [editor, item.id, session])
  useEffect(() => { onDirtyChange?.(tabId, dirty || unconfirmed); return () => onDirtyChange?.(tabId, false) }, [dirty, unconfirmed, tabId, onDirtyChange])
  useEffect(() => {
    if (!dirty && !unconfirmed) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn)
  }, [dirty, unconfirmed])
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
  useEffect(() => { if (!session) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [session])
  const expired = !!session && Date.parse(session.expiresAt) <= now
  const recoveryExpired = !!session && Date.parse(session.recoveryExpiresAt) <= now
  const resource = session && saved ? savedOfficeDocument(item, session.fileType, session.saveAsCopy, saved) : item
  const download = session && enabled && !recoveryExpired ? editor.downloadUrl?.(item.id, session.id) : undefined
  const driveUrl = unconfirmed && session?.saveAsCopy && !saved ? "https://drive.google.com/drive/u/0/my-drive" : resource.openUrl
  const controller = useCollaboraController({ frame, session, ready: ready && enabled && !saving && !expired && !unconfirmed, canEdit: !!session?.canEdit && enabled && !saving && !expired && !unconfirmed, active })
  const save = async (closeAfter = false) => {
    if (!session || !enabled || saving || expired || unconfirmed || !ready || !session.canEdit) return
    const generation = changes.current; setSaving(true); setError(undefined)
    let writeStarted = false
    try {
      const previous = await editor.status(item.id, session.id)
      if (previous.uncertain) { setUnconfirmed(true); throw new Error("Save not confirmed. Check Drive before making another save.") }
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
      if (status.uncertain) { setUnconfirmed(true); throw new Error("Save not confirmed. Check Drive before making another save.") }
      writeStarted = true
      const result = await editor.save(item.id, session.id, status.draftVersion)
      if (!mounted.current) return
      setSaved(result.fileId)
      onResourceChange?.(tabId, savedOfficeDocument(item, session.fileType, session.saveAsCopy, result.fileId))
      if (generation === changes.current) { setDirty(false); setClosing(false); if (closeAfter) onClose() }
    } catch (failure) {
      if (mounted.current) {
        // Once a Drive write was attempted, a lost reply cannot authorize replay.
        if (writeStarted) setUnconfirmed(true)
        setError(writeStarted ? "Save not confirmed. Check Drive before making another save." : failure instanceof Error ? failure.message : "Couldn't prepare the save. Your changes remain in this tab.")
      }
    }
    finally { if (mounted.current) setSaving(false) }
  }
  const status = unconfirmed ? "Save not confirmed" : expired ? "Session expired" : saving ? "Saving to Drive…" : dirty ? "Unsaved to Drive" : saved ? "Saved to Drive" : !session?.canEdit && session ? "Read-only" : ""
  return <section className="ow-document-editor ow-office-editor" hidden={!active} aria-label={resource.name}>
    <EditorActions active={active} host={toolbarHost}><span role="status">{status}</span>{driveUrl && <a href={driveUrl} target="_blank" rel="noopener noreferrer" aria-label={unconfirmed ? "Check Drive" : saved && session?.saveAsCopy ? "Open saved copy in Drive" : "Open original in Drive"}><ExternalLink size={16}/></a>}<button type="button" disabled={!enabled || !session?.canEdit || !ready || saving || expired || unconfirmed || (!dirty && (!session.saveAsCopy || !!saved))} onClick={() => void save()}><Save size={15}/>{session?.saveAsCopy && !saved ? `Save ${formatLabel} copy to Drive` : "Save to Drive"}</button>{!onControlsChange && <button type="button" aria-label={`Close ${resource.name}`} disabled={saving} onClick={() => closeAction.current()}><X size={16}/></button>}</EditorActions>
    {closing && <div className="ow-editor-message ow-office-message" role="status">{unconfirmed ? "The latest save wasn't confirmed. Check Drive before closing." : "This file has changes that haven't been saved to Drive."}<button type="button" disabled={saving || !enabled || !ready || expired || unconfirmed || !session?.canEdit} onClick={() => void save(true)}>Save and close</button><button type="button" disabled={saving} onClick={() => setClosing(false)}>{expired || unconfirmed ? "Keep tab open" : "Keep editing"}</button><button type="button" disabled={saving} onClick={onClose}>Close tab</button></div>}
    {session?.saveAsCopy && <div className="ow-editor-message ow-office-message">{saved ? "Your copy is saved in My Drive. Further saves update that copy." : `You’re editing ${/^[aeiou]/i.test(formatLabel) ? "an" : "a"} ${formatLabel} copy. Save creates a new file in My Drive; the Google original stays unchanged.`}{saved && <a href={`https://drive.google.com/file/d/${encodeURIComponent(saved)}/view`} target="_blank" rel="noopener noreferrer">Open saved copy</a>}</div>}
    {!enabled && <div className="ow-editor-message ow-office-message">Documents is off for this workspace.</div>}
    {(error || query.isError || expired) && <div className="ow-editor-message ow-office-message" role="alert">{expired ? recoveryExpired ? "This editing session and its recovery copy expired. Check the saved file in Drive." : "This editing session expired. The last received copy is available for 15 minutes; edits still in the editor may be missing." : error ?? (query.error instanceof Error ? query.error.message : "Couldn't open the full editor.")}{driveUrl && <a href={driveUrl} target="_blank" rel="noopener noreferrer">Check Drive</a>}</div>}
    {download && <div className="ow-editor-message ow-office-message"><a href={download} download title="Only changes already received by the document service are included.">Download last received copy</a>{(expired || unconfirmed) && <span>Only changes already received by the document service are included.</span>}</div>}
    {!session && query.isPending && <div className="ow-documents-skeleton" aria-label="Opening full editor" aria-busy="true"><div/><div/><div/></div>}
    {session && <DocumentToolbar controller={controller}/>}
    {session && <div className="ow-office-canvas" inert={saving || !enabled || expired || unconfirmed} aria-busy={saving}>
      <form ref={form} method="post" action={collaboraWorkspaceUrl(session.editorUrl)} target={frameName} hidden><input type="hidden" name="access_token" value={session.accessToken}/><input type="hidden" name="access_token_ttl" value={Date.parse(session.expiresAt)}/></form>
      <iframe ref={frame} name={frameName} title={`Edit ${resource.name}`} className="ow-office-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-modals" allow="clipboard-read; clipboard-write" allowFullScreen referrerPolicy="no-referrer"/>
    </div>}
  </section>
}
