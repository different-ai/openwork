"use client"

import { useEffect, useId, useRef } from "react"

/**
 * Asks before closing a file with unsaved changes, as a desktop app does: save, don't save
 * or cancel. A modal <dialog> keeps focus inside, dims the page and closes on Escape.
 */
export function UnsavedChangesDialog({ name, saveLabel, saving, canSave, error, onSave, onDiscard, onCancel }: {
  name: string
  saveLabel: string
  saving: boolean
  canSave: boolean
  error?: string | null
  onSave(): void
  onDiscard(): void
  onCancel(): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const saveButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
    // showModal focuses the first button, "Don't save"; start on the safe choice instead.
    ;(saveButton.current && !saveButton.current.disabled ? saveButton.current : cancelButton.current)?.focus()
    return () => element?.close()
  }, [])
  return <dialog ref={dialog} className="ow-unsaved-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} onCancel={event => { event.preventDefault(); if (!saving) onCancel() }}>
    <h2 id={`${id}-title`}>Save changes to “{name}”?</h2>
    <p id={`${id}-body`}>If you don’t save, your changes since the last save will be lost.</p>
    {error && <p className="ow-unsaved-dialog-error" role="alert">{error}</p>}
    <div className="ow-unsaved-dialog-actions">
      <button type="button" className="ow-unsaved-dialog-discard" disabled={saving} onClick={onDiscard}>Don’t save</button>
      <button type="button" ref={cancelButton} disabled={saving} onClick={onCancel}>Cancel</button>
      <button type="button" ref={saveButton} className="ow-unsaved-dialog-save" disabled={!canSave || saving} onClick={onSave}>{saving ? "Saving…" : saveLabel}</button>
    </div>
  </dialog>
}
