/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { FolderPlus, Loader2, Rocket, X } from "lucide-react";

import { Button } from "../../design-system/button";

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

  if (!props.open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-1/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl overflow-hidden rounded-[28px] border border-dls-border bg-dls-surface shadow-2xl animate-in fade-in zoom-in-95 duration-200">
        <div className="border-b border-dls-border px-6 py-5 bg-dls-surface">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-dls-accent/10 text-dls-accent">
                <Rocket size={20} />
              </div>
              <div className="min-w-0">
                <h3 className="truncate text-[18px] font-semibold text-dls-text">
                  Start with {props.templateName}
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-dls-secondary">
                  {props.description?.trim() ||
                    "Pick a folder and OpenWork will create a workspace from this template."}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={props.onClose}
              disabled={Boolean(props.busy)}
              className="rounded-full p-1 text-dls-secondary transition hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>

          {visibleItems.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-2">
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
        </div>

        <div className="space-y-4 px-6 py-6">
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

          <div className="flex items-center justify-end gap-3 border-t border-dls-border pt-4">
            <Button
              variant="ghost"
              onClick={props.onClose}
              disabled={Boolean(props.busy)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void props.onConfirm(selectedFolder)}
              disabled={!canSubmit}
            >
              {props.busy ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin" />
                  Starting template...
                </span>
              ) : (
                "Create workspace"
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
