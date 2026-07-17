"use client";

import { Dithering } from "@paper-design/shaders-react";
import Link from "next/link";
import { Building2, ChevronRight, LogOut, Plus } from "lucide-react";
import { useSyncExternalStore } from "react";
import { formatRoleLabel, type DenOrgSummary } from "../../_lib/den-org";
import { useOrgListWindow } from "../../_lib/use-org-list-window";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onStoreChange: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
  mediaQuery.addEventListener("change", onStoreChange);

  return () => mediaQuery.removeEventListener("change", onStoreChange);
}

function getReducedMotionSnapshot() {
  return typeof window === "undefined" ? true : window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function getReducedMotionServerSnapshot() {
  return true;
}

function useReducedMotion() {
  return useSyncExternalStore(subscribeToReducedMotion, getReducedMotionSnapshot, getReducedMotionServerSnapshot);
}

export function OrgSelectionScreen({
  orgs,
  onSelect,
  onSignOut,
  busy,
  error,
}: {
  orgs: DenOrgSummary[];
  onSelect: (slug: string) => void;
  onSignOut: () => void;
  busy: boolean;
  error: string | null;
}) {
  const {
    query,
    setQuery,
    visible,
    filteredCount,
    hasMore,
    showMore,
    showSearch,
  } = useOrgListWindow(orgs);
  const reducedMotion = useReducedMotion();
  const shaderSpeed = reducedMotion ? 0 : 0.012;

  return (
    <div className="relative isolate min-h-dvh overflow-y-auto bg-[#0f1d31] px-4 py-8 sm:py-12" data-testid="org-chooser-root">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 overflow-hidden bg-[#0f1d31] opacity-[0.10]"
        data-testid="org-chooser-background"
      >
        <Dithering
          speed={shaderSpeed}
          shape="warp"
          type="4x4"
          size={2.4}
          scale={0.9}
          frame={24017.6}
          colorBack="#09182C"
          colorFront="#A7C4E8"
          style={{ backgroundColor: "#142033", width: "100%", height: "100%" }}
        />
      </div>

      <div className="relative z-10 mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-md flex-col justify-center sm:min-h-[calc(100dvh-6rem)]" data-testid="org-chooser-foreground">
        <div className="mb-6 text-center">
          <h1 className="text-[18px] font-semibold tracking-[-0.2px] text-white">
            Choose an organization
          </h1>
          <p className="mt-1 text-[13px] text-slate-300">
            You belong to {orgs.length} organizations. Select one to continue.
          </p>
        </div>

        {showSearch ? (
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search organizations"
            className="mb-3 w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-[13px] text-gray-900 shadow-[0_18px_45px_-32px_rgba(3,10,24,0.9)] outline-none transition focus:border-gray-400 focus:ring-4 focus:ring-sky-950/10"
          />
        ) : null}

        <div className="grid gap-2 rounded-xl border border-gray-200 bg-white p-2 shadow-[0_20px_60px_-30px_rgba(3,10,24,0.75)]" data-testid="org-chooser-list">
          {visible.map((org) => (
            <button
              key={org.id}
              type="button"
              disabled={busy}
              onClick={() => onSelect(org.slug)}
              className="flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-gray-50 focus:outline-none focus:ring-4 focus:ring-sky-950/10 disabled:cursor-not-allowed disabled:bg-gray-50"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#eef3f8] text-[#41566f]">
                  <Building2 className="h-4 w-4" strokeWidth={1.8} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-medium text-gray-900">{org.name}</span>
                  <span className="block truncate text-[12px] text-gray-500">
                    {formatRoleLabel(org.role)} • {org.memberCount} {org.memberCount === 1 ? "member" : "members"}
                  </span>
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-gray-300" strokeWidth={2} />
            </button>
          ))}
        </div>

        {filteredCount === 0 && query ? (
          <p className="mt-3 px-1 text-[13px] text-slate-300">No organizations match your search.</p>
        ) : null}

        {hasMore ? (
          <div className="mt-3 flex items-center justify-between gap-3 px-1">
            <p className="text-[12px] text-slate-300">
              Showing {visible.length} of {filteredCount} organizations
            </p>
            <button
              type="button"
              onClick={showMore}
              className="shrink-0 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[12px] font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              Show more
            </button>
          </div>
        ) : null}

        {error ? (
          <p className="mt-3 px-1 text-[12px] font-medium text-rose-200">{error}</p>
        ) : null}

        <div className="mt-4 flex items-center justify-between gap-3 px-1" data-testid="org-chooser-actions">
          <Link
            href="/organization"
            className="flex items-center gap-1.5 text-[13px] font-medium text-slate-200 transition-colors hover:text-white focus:outline-none focus:ring-4 focus:ring-white/15"
          >
            <Plus className="h-4 w-4 text-slate-300" /> Create or join
          </Link>
          <button
            type="button"
            onClick={onSignOut}
            className="flex items-center gap-1.5 text-[13px] font-medium text-slate-200 transition-colors hover:text-white focus:outline-none focus:ring-4 focus:ring-white/15"
          >
            <LogOut className="h-4 w-4 text-slate-300" /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
