"use client";

import { Dialog } from "@base-ui/react/dialog";
import { useState, type FormEvent } from "react";
import { DenButton, buttonVariants } from "../../../_components/ui/button";
import { DenInput } from "../../../_components/ui/input";
import { ConfirmDialog, ItemMenu, type ItemMenuEntry } from "../../_components/item-list";
import { secondaryText } from "./computer-parts";
import type { ComputerAction, ConfirmCopy } from "./computer-actions";

/*
 * The controls for what a person can do to one computer: the row's `…` menu,
 * the same actions as buttons on an open detail, and the rename dialog.
 * Disconnect and Remove always ask first, in words that say what happens.
 */

export type ComputerActionSet = {
  /** In menu order; empty renders no menu. */
  actions: readonly ComputerAction[];
  name: string;
  disconnectConfirm: ConfirmCopy;
  removeConfirm: ConfirmCopy;
  /** Each resolves when done and throws the line to show when refused. */
  onDisconnect: () => Promise<void>;
  onRemove: () => Promise<void>;
  onRename?: (label: string) => Promise<void>;
};

const LABELS: Record<ComputerAction, string> = { rename: "Rename", disconnect: "Disconnect", remove: "Remove from list" };

/** The menu's entries: what is offered, with what it asks before doing it. `idPrefix` is `computer` or `my-computer`. */
export function computerMenuEntries(set: ComputerActionSet, input: { idPrefix: string; id: string; onRename: () => void }): ItemMenuEntry[] {
  return set.actions.map((action): ItemMenuEntry => {
    const testId = `${input.idPrefix}-${action}-${input.id}`;
    if (action === "rename") return { label: LABELS.rename, testId, onSelect: input.onRename };
    if (action === "disconnect") return { label: LABELS.disconnect, testId, destructive: true, confirm: set.disconnectConfirm, onSelect: set.onDisconnect };
    return { label: LABELS.remove, testId, destructive: true, confirm: set.removeConfirm, onSelect: set.onRemove };
  });
}

/** The row's `…` menu. Renders nothing when there is nothing the person can do. */
export function ComputerMenu({ set, idPrefix, id }: { set: ComputerActionSet; idPrefix: string; id: string }) {
  const [renaming, setRenaming] = useState(false);
  if (set.actions.length === 0) return null;
  return <>
    <ItemMenu label={`Actions for ${set.name}`} testId={`${idPrefix}-menu-${id}`} entries={computerMenuEntries(set, { idPrefix, id, onRename: () => setRenaming(true) })} />
    {set.onRename ? <RenameComputerDialog open={renaming} name={set.name} onRename={set.onRename} onClose={() => setRenaming(false)} /> : null}
  </>;
}

/** Disconnect and Remove as buttons, for the top of an open detail. */
export function ComputerActionButtons({ set, idPrefix, id }: { set: ComputerActionSet; idPrefix: string; id: string }) {
  const [confirming, setConfirming] = useState<"disconnect" | "remove" | null>(null);
  const offered = set.actions.filter((action): action is "disconnect" | "remove" => action !== "rename");
  if (offered.length === 0) return null;
  return <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
    {offered.map((action) => <DenButton key={action} variant="secondary" size="sm" data-testid={`${idPrefix}-detail-${action}-${id}`} onClick={() => setConfirming(action)}>
      {LABELS[action]}
    </DenButton>)}
    <ConfirmDialog destructive confirm={confirming === "disconnect" ? set.disconnectConfirm : confirming === "remove" ? set.removeConfirm : null}
      onConfirm={() => confirming === "disconnect" ? set.onDisconnect() : set.onRemove()} onClose={() => setConfirming(null)} />
  </div>;
}

const popupClass = "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-gray-200 bg-white p-5 outline-none";

function RenameForm({ name, onRename, onClose }: { name: string; onRename: (label: string) => Promise<void>; onClose: () => void }) {
  const [label, setLabel] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = label.trim();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!next || busy) return;
    if (next === name) { onClose(); return; }
    setBusy(true);
    setError(null);
    try {
      await onRename(next);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error && failure.message.trim() ? failure.message : "Couldn't rename this computer. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return <form onSubmit={(event) => void submit(event)}>
    <Dialog.Title className="text-[15px] font-medium text-gray-950">Rename {name}</Dialog.Title>
    <div className="mt-4">
      <DenInput type="text" aria-label="Computer name" maxLength={80} autoFocus value={label} disabled={busy} onChange={(event) => setLabel(event.target.value)} />
    </div>
    {error ? <p role="alert" className="mt-3 break-words text-[13px] text-[var(--ow-danger)]">{error}</p> : null}
    <div className="mt-5 flex justify-end gap-2">
      <Dialog.Close disabled={busy} className={buttonVariants({ variant: "secondary" })}>Cancel</Dialog.Close>
      <DenButton type="submit" loading={busy} disabled={!next}>Save name</DenButton>
    </div>
  </form>;
}

/** The owner's own name for a computer. */
export function RenameComputerDialog({ open, name, onRename, onClose }: {
  open: boolean;
  name: string;
  onRename: (label: string) => Promise<void>;
  onClose: () => void;
}) {
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/20" />
      <Dialog.Popup data-testid="computer-rename-dialog" className={popupClass}>
        {/* Mounted per opening, so the field always starts from the current name. */}
        {open ? <RenameForm name={name} onRename={onRename} onClose={onClose} /> : null}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** How a computer gets onto these lists. Den adds none itself: it says where to do it. */
export function AddComputerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/20" />
      <Dialog.Popup data-testid="add-computer-dialog" className={popupClass}>
        <Dialog.Title className="text-[15px] font-medium text-gray-950">Add a computer</Dialog.Title>
        <ul className="mt-3 space-y-3 text-[13px] leading-5 text-[color:var(--dls-text-primary)]">
          <li>
            <p className="font-medium">A Mac or PC</p>
            <p className={secondaryText}>Sign in to OpenWork on it with this organization. It appears here by itself.</p>
          </li>
          <li>
            <p className="font-medium">A virtual computer you already have</p>
            <p className={secondaryText}>Add it in the desktop app, under Settings &gt; Devices.</p>
          </li>
        </ul>
        <p className={`mt-3 text-[12px] leading-4 ${secondaryText}`}>Adding a computer doesn&apos;t create one or give anyone access to it.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Dialog.Close className={buttonVariants({ variant: "secondary" })}>Close</Dialog.Close>
          <a href="openwork://open" data-testid="add-computer-open" className={buttonVariants({ variant: "primary" })}>Open OpenWork</a>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
