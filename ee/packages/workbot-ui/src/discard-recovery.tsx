"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useState } from "react";

/** A deliberate local discard, never cancellation or a mutation of saved files. */
export function DiscardRetainedRecovery({ onDiscard }: { onDiscard(): void }) {
  const [open, setOpen] = useState(false);
  const button = "rounded-full bg-[var(--wb-chip)] px-4 py-2 text-[13px] text-[var(--wb-text)] focus-visible:outline focus-visible:outline-2";
  return <AlertDialog.Root open={open} onOpenChange={setOpen}>
    <AlertDialog.Trigger className={button}>Discard retained changes</AlertDialog.Trigger>
    <AlertDialog.Portal>
      <AlertDialog.Backdrop className="workbot fixed inset-0 z-50 bg-[var(--wb-ink)]/20" />
      <AlertDialog.Popup className="workbot fixed left-1/2 top-1/2 z-50 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-[var(--wb-surface)] p-5 text-[var(--wb-text)] shadow-[var(--wb-panel-shadow)] outline-none">
        <AlertDialog.Title className="text-[15px] font-semibold">Discard retained changes?</AlertDialog.Title>
        <AlertDialog.Description className="mt-2 text-[13px] text-[var(--wb-muted)]">This only forgets recovery in this browser. It neither changes saved files nor cancels requests already sent.</AlertDialog.Description>
        <div className="mt-4 flex justify-end gap-2"><AlertDialog.Close className={button}>Keep recovery</AlertDialog.Close><button type="button" className={button} onClick={onDiscard}>Discard and switch</button></div>
      </AlertDialog.Popup>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}
