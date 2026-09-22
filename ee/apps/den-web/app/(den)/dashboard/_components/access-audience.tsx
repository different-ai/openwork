"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Globe, Loader2, Plus, Users } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";

/**
 * Access pieces shared by "Who sees this dashboard" (Dashboards) and
 * "Who can use it" (AI Gateway): team identity, the dashed "+ Add person /
 * + Add team" pickers and the "Everyone in the organization" toggle row.
 */

export type AccessCandidate = {
  id: string;
  searchText: string;
  content: ReactNode;
};

export function formatAccessDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

export function TeamIdentity({ name, memberCount }: { name: string; memberCount: number }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-gray-100 text-gray-500">
        <Users className="h-4 w-4" aria-hidden />
      </div>
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-gray-900">{name}</p>
        <p className="truncate text-[12px] text-gray-400">
          {memberCount} {memberCount === 1 ? "member" : "members"}, future members included
        </p>
      </div>
    </div>
  );
}

export function AccessAddPicker({
  kind,
  candidates,
  disabled,
  onGrant,
}: {
  kind: "person" | "team";
  candidates: AccessCandidate[];
  disabled: boolean;
  onGrant: (id: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (ref.current && !event.composedPath().includes(ref.current)) {
        setOpen(false);
        setQuery("");
        setSelectedId(null);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  const filteredCandidates = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return candidates;
    return candidates.filter((candidate) => candidate.searchText.includes(normalized));
  }, [candidates, query]);

  function resetAndClose() {
    setOpen(false);
    setQuery("");
    setSelectedId(null);
  }

  async function handleGrant() {
    if (!selectedId) return;
    setSubmitting(true);
    try {
      await onGrant(selectedId);
      resetAndClose();
    } catch {
      // The mutation error is rendered below the access container.
    } finally {
      setSubmitting(false);
    }
  }

  const label = kind === "person" ? "person" : "team";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled || candidates.length === 0}
        onClick={() => {
          if (open) {
            resetAndClose();
          } else {
            setOpen(true);
          }
        }}
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-gray-300 px-3 py-1.5 text-[11.5px] text-gray-500 transition hover:border-gray-500 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus className="h-3 w-3" aria-hidden />
        Add {label}
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6 md:absolute md:inset-auto md:left-0 md:top-[calc(100%+6px)] md:z-20 md:block md:bg-transparent md:p-0"
          onClick={(event) => {
            if (event.target === event.currentTarget) resetAndClose();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Add ${label} access`}
            className="w-full max-w-[340px] rounded-2xl border border-gray-200 bg-white md:w-[340px]"
          >
            <div className="border-b border-gray-100 p-3">
              <DenInput
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${kind === "person" ? "people" : "teams"}...`}
                autoFocus
              />
            </div>
            <div className="max-h-[220px] divide-y divide-gray-100 overflow-y-auto">
              {filteredCandidates.length === 0 ? (
                <p className="px-4 py-5 text-center text-[12px] text-gray-400">No matches</p>
              ) : (
                filteredCandidates.map((candidate) => {
                  const selected = candidate.id === selectedId;
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      onClick={() => setSelectedId(candidate.id)}
                      className={`flex w-full items-center gap-3 px-4 py-3 text-left transition ${selected ? "bg-gray-50" : "hover:bg-gray-50/70"}`}
                    >
                      <div className="min-w-0 flex-1">{candidate.content}</div>
                      <Check className={`h-4 w-4 shrink-0 ${selected ? "text-emerald-600" : "text-transparent"}`} aria-hidden />
                    </button>
                  );
                })
              )}
            </div>
            <div className="flex justify-end border-t border-gray-100 p-3">
              <DenButton size="sm" disabled={!selectedId || submitting} onClick={() => void handleGrant()}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Grant
              </DenButton>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The "Everyone in the organization" row: globe, state line, switch. */
export function OrgWideAccessToggle({
  on,
  disabled = false,
  onDescription,
  offDescription,
  onToggle,
}: {
  on: boolean;
  disabled?: boolean;
  onDescription: string;
  offDescription: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className="flex w-full items-center gap-4 rounded-t-2xl px-6 py-4 text-left transition hover:bg-gray-50/60 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${on ? "bg-emerald-50 text-emerald-600" : "bg-gray-100 text-gray-500"}`}>
        <Globe className="h-4 w-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold tracking-[-0.01em] text-gray-900">
          Everyone in the organization
        </p>
        <p className="mt-0.5 text-[12.5px] leading-[1.55] text-gray-500">
          {on ? onDescription : offDescription}
        </p>
      </div>
      <div
        role="switch"
        aria-checked={on}
        aria-label="Everyone in the organization"
        className={`relative inline-flex h-6 w-[42px] shrink-0 items-center rounded-full transition-colors ${on ? "bg-[#0f172a]" : "bg-gray-200"}`}
      >
        <span className={`inline-block h-5 w-5 rounded-full bg-white transition-transform ${on ? "translate-x-[18px]" : "translate-x-0.5"}`} />
      </div>
    </button>
  );
}

/** One granted person or team with its Revoke action. */
export function AccessGrantRow({
  identity,
  meta,
  disabled = false,
  onRevoke,
}: {
  identity: ReactNode;
  meta?: ReactNode;
  disabled?: boolean;
  onRevoke: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4 md:flex-row md:flex-wrap md:items-center md:px-6 md:py-3.5">
      <div className="w-full min-w-0 md:w-auto md:min-w-[220px] md:flex-1">{identity}</div>
      {meta ? <p className="text-[11.5px] text-gray-400">{meta}</p> : null}
      <div className="flex w-full justify-end md:w-auto">
        <DenButton size="sm" variant="destructive" disabled={disabled} onClick={onRevoke}>
          Revoke
        </DenButton>
      </div>
    </div>
  );
}
