/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  Plus,
  Sparkles,
  X,
} from "lucide-react";

import type { BundleWorkerOption } from "./types";

export type BundleImportModalProps = {
  open: boolean;
  title: string;
  description: string;
  items: string[];
  workers: BundleWorkerOption[];
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onCreateNewWorker: () => void;
  onSelectWorker: (workspaceId: string) => void;
};

export function BundleImportModal(props: BundleImportModalProps) {
  const [showWorkers, setShowWorkers] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setShowWorkers(false);
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      props.onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [props]);

  const visibleItems = useMemo(
    () => props.items.filter(Boolean).slice(0, 4),
    [props.items],
  );
  const hiddenItemCount = useMemo(
    () =>
      Math.max(
        0,
        props.items.filter(Boolean).length - visibleItems.length,
      ),
    [props.items, visibleItems.length],
  );

  if (!props.open) return null;
  const busy = Boolean(props.busy);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-1/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-gray-6 bg-gray-2 shadow-2xl">
        <div className="border-b border-gray-6 bg-gray-1 px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-9/15 text-indigo-11">
                <Boxes size={20} />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-12">
                  {props.title}
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-gray-10">
                  {props.description}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={props.onClose}
              disabled={busy}
              className="rounded-full p-1 text-gray-10 transition hover:bg-gray-4 hover:text-gray-12 disabled:cursor-not-allowed disabled:opacity-50"
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
                  className="rounded-full border border-gray-6 bg-gray-3 px-3 py-1 text-xs font-medium text-gray-11"
                >
                  {item}
                </span>
              ))}
              {hiddenItemCount > 0 ? (
                <span className="rounded-full border border-gray-6 bg-gray-3 px-3 py-1 text-xs font-medium text-gray-11">
                  +{hiddenItemCount} more
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="space-y-4 p-6">
          {props.error?.trim() ? (
            <div className="rounded-xl border border-red-6 bg-red-2 px-4 py-3 text-sm text-red-11">
              {props.error}
            </div>
          ) : null}

          <button
            type="button"
            onClick={props.onCreateNewWorker}
            disabled={busy}
            className="flex w-full items-center justify-between rounded-2xl border border-indigo-7/30 bg-indigo-9/10 px-4 py-4 text-left transition hover:border-indigo-7/50 hover:bg-indigo-9/15 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-9/20 text-indigo-11">
                <Plus size={18} />
              </div>
              <div>
                <div className="text-sm font-semibold text-gray-12">
                  Create new worker
                </div>
                <div className="mt-1 text-sm text-gray-10">
                  Open the existing new worker flow, then import this bundle into
                  it.
                </div>
              </div>
            </div>
            <Sparkles size={18} className="text-indigo-11" />
          </button>

          <div className="rounded-2xl border border-gray-6 bg-gray-1/70">
            <button
              type="button"
              onClick={() => setShowWorkers((value) => !value)}
              disabled={busy}
              className="flex w-full items-center justify-between gap-3 px-4 py-4 text-left transition hover:bg-gray-3/60 disabled:cursor-not-allowed disabled:opacity-60"
              aria-expanded={showWorkers}
            >
              <div>
                <div className="text-sm font-semibold text-gray-12">
                  Add to existing worker
                </div>
                <div className="mt-1 text-sm text-gray-10">
                  Pick an existing worker and import this bundle there.
                </div>
              </div>
              {showWorkers ? (
                <ChevronDown size={18} className="text-gray-10" />
              ) : (
                <ChevronRight size={18} className="text-gray-10" />
              )}
            </button>

            {showWorkers ? (
              <div className="space-y-3 border-t border-gray-6 px-4 py-4">
                {props.workers.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-6 px-4 py-5 text-sm text-gray-10">
                    No configured workers are available yet. Create a new worker
                    to import this bundle.
                  </div>
                ) : (
                  props.workers.map((worker) => {
                    const disabledReason = worker.disabledReason?.trim() ?? "";
                    const disabled = Boolean(disabledReason) || busy;
                    return (
                      <button
                        key={worker.id}
                        type="button"
                        onClick={() => props.onSelectWorker(worker.id)}
                        disabled={disabled}
                        className="w-full rounded-xl border border-gray-6 bg-gray-2 px-4 py-3 text-left transition hover:border-gray-7 hover:bg-gray-3 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-semibold text-gray-12">
                                {worker.label}
                              </span>
                              <span className="rounded-full border border-gray-6 bg-gray-3 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-10">
                                {worker.badge}
                              </span>
                              {worker.current ? (
                                <span className="rounded-full border border-emerald-7/40 bg-emerald-9/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-emerald-11">
                                  Current
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1 truncate text-sm text-gray-10">
                              {worker.detail}
                            </div>
                            {disabledReason ? (
                              <div className="mt-2 text-xs text-amber-11">
                                {disabledReason}
                              </div>
                            ) : null}
                          </div>
                          <ChevronRight
                            size={18}
                            className="mt-0.5 shrink-0 text-gray-10"
                          />
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
