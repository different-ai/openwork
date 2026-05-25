/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { FolderPlus, Loader2, Rocket } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type BundleStartModalProps = {
  open: boolean;
  templateName: string;
  description?: string | null;
  items?: string[];
  busy?: boolean;
  onClose: () => void;
  onPickFolder: () => Promise<string | null>;
  onConfirm: (folder: string | null) => void | Promise<void>;
};

export function BundleStartModal(props: BundleStartModalProps) {
  const pickFolderRef = useRef<HTMLButtonElement | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [pickingFolder, setPickingFolder] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setSelectedFolder(null);
    const frame = requestAnimationFrame(() => pickFolderRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (props.busy) return;
      props.onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [props, props.busy, props.open]);

  const visibleItems = useMemo(
    () => (props.items ?? []).filter(Boolean).slice(0, 4),
    [props.items],
  );
  const hiddenItemCount = useMemo(
    () =>
      Math.max(
        0,
        (props.items ?? []).filter(Boolean).length - visibleItems.length,
      ),
    [props.items, visibleItems.length],
  );
  const canSubmit = useMemo(
    () => Boolean(selectedFolder?.trim()) && !props.busy && !pickingFolder,
    [pickingFolder, props.busy, selectedFolder],
  );
  let description = props.description?.trim();
  if (!description) {
    description = "Pick a folder and OpenWork will create a workspace from this template.";
  }

  const handlePickFolder = async () => {
    if (pickingFolder || props.busy) return;
    setPickingFolder(true);
    try {
      const next = await props.onPickFolder();
      if (next) setSelectedFolder(next);
    } finally {
      setPickingFolder(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onClose();
      }}
    >
      <DialogContent className="flex max-h-[90vh] min-h-0 w-full max-w-xl flex-col overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <div className="flex items-start gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-dls-accent/10 text-dls-accent">
                <Rocket size={20} />
              </div>
              <div className="min-w-0">
                <DialogTitle className="truncate">
                  Start with {props.templateName}
                </DialogTitle>
                <DialogDescription>
                  {description}
                </DialogDescription>
              </div>
            </div>
          </div>
        </DialogHeader>

        {visibleItems.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {visibleItems.map((item) => (
              <span
                key={item}
                className="rounded-full border border-dls-border bg-dls-hover px-3 py-1 text-xs font-medium text-dls-text"
              >
                {item}
              </span>
            ))}
            {hiddenItemCount > 0 ? (
              <span className="rounded-full border border-dls-border bg-dls-hover px-3 py-1 text-xs font-medium text-dls-text">
                +{hiddenItemCount} more
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          <div className="rounded-2xl border border-dls-border bg-dls-sidebar px-5 py-4">
            <div className="text-[15px] font-semibold text-dls-text">
              Workspace folder
            </div>
            <p className="mt-1 text-sm text-dls-secondary">
              Choose where this template should live. OpenWork will create the
              workspace and bring in the template automatically.
            </p>
            <div className="mt-4 rounded-xl border border-dls-border bg-dls-surface px-4 py-3 text-sm text-dls-text">
              {selectedFolder?.trim() ? (
                <span className="font-mono text-xs break-all">
                  {selectedFolder}
                </span>
              ) : (
                <span className="text-dls-secondary">
                  No folder selected yet.
                </span>
              )}
            </div>
            <div className="mt-4">
              <button
                type="button"
                ref={pickFolderRef}
                onClick={handlePickFolder}
                disabled={pickingFolder || Boolean(props.busy)}
                className="inline-flex items-center gap-2 rounded-full border border-dls-border bg-dls-surface px-4 py-2 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover disabled:cursor-wait disabled:opacity-70"
              >
                {pickingFolder ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <FolderPlus size={14} />
                )}
                {selectedFolder?.trim() ? "Change folder" : "Select folder"}
              </button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <DialogClose
            disabled={Boolean(props.busy)}
            render={<Button variant="outline" disabled={Boolean(props.busy)} />}
          >
            Cancel
          </DialogClose>
          <Button
            onClick={() => void props.onConfirm(selectedFolder)}
            disabled={!canSubmit}
          >
            {props.busy ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 size={16} className="animate-spin" />
                Starting template…
              </span>
            ) : (
              "Create workspace"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
