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
  return typeof window === "undefined"
    ? true
    : window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function getReducedMotionServerSnapshot() {
  return true;
}

function useReducedMotion() {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot,
  );
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
    <section
      className="relative isolate min-h-dvh overflow-y-auto bg-[#f8fbff] px-4 py-8 text-slate-950 sm:py-12"
      data-testid="org-chooser-root"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 overflow-hidden bg-[#f8fbff] opacity-[0.09]"
        data-motion={shaderSpeed === 0 ? "reduced" : "ambient"}
        data-shader-speed={shaderSpeed}
        data-testid="org-chooser-background"
      >
        <Dithering
          speed={shaderSpeed}
          shape="warp"
          type="4x4"
          size={2.4}
          scale={0.9}
          frame={24017.6}
          colorBack="#F8FBFF"
          colorFront="#8FB7E8"
          style={{ backgroundColor: "#F8FBFF", width: "100%", height: "100%" }}
        />
      </div>

      <div
        className="relative z-10 mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-md flex-col justify-center sm:min-h-[calc(100dvh-6rem)]"
        data-testid="org-chooser-foreground"
      >
        <div className="den-frame w-full p-6 md:p-8">
          <div className="mb-6 text-center">
            <h1 className="den-title-lg">Choose an organization</h1>
            <p className="mt-2 text-[13px] text-[var(--dls-text-secondary)]">
              You belong to {orgs.length} organizations. Select one to continue.
            </p>
          </div>

          {showSearch ? (
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search organizations"
              className="den-input mb-3 px-3 py-2.5 text-[13px]"
            />
          ) : null}

          <div
            className="den-frame-inset grid gap-2 rounded-[1.5rem] p-2"
            data-testid="org-chooser-list"
          >
            {visible.map((org) => (
              <button
                key={org.id}
                type="button"
                disabled={busy}
                onClick={() => onSelect(org.slug)}
                className="flex items-center justify-between gap-3 rounded-[1rem] px-3 py-2.5 text-left transition-colors hover:bg-white focus:outline-none focus:ring-4 focus:ring-slate-950/5 disabled:cursor-not-allowed disabled:bg-white"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-[var(--dls-text-secondary)] shadow-sm">
                    <Building2 className="h-4 w-4" strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-medium text-gray-900">
                      {org.name}
                    </span>
                    <span className="block truncate text-[12px] text-gray-500">
                      {formatRoleLabel(org.role)} • {org.memberCount}{" "}
                      {org.memberCount === 1 ? "member" : "members"}
                    </span>
                  </span>
                </span>
                <ChevronRight
                  className="h-4 w-4 shrink-0 text-gray-300"
                  strokeWidth={2}
                />
              </button>
            ))}
          </div>

          {filteredCount === 0 && query ? (
            <p className="mt-3 px-1 text-[13px] text-[var(--dls-text-secondary)]">
              No organizations match your search.
            </p>
          ) : null}

          {hasMore ? (
            <div className="mt-3 flex items-center justify-between gap-3 px-1">
              <p className="text-[12px] text-[var(--dls-text-secondary)]">
                Showing {visible.length} of {filteredCount} organizations
              </p>
              <button
                type="button"
                onClick={showMore}
                className="shrink-0 rounded-full border border-[var(--dls-border)] bg-white px-3 py-1.5 text-[12px] font-medium text-gray-700 transition-colors hover:bg-slate-50"
              >
                Show more
              </button>
            </div>
          ) : null}

          {error ? (
            <p className="mt-3 px-1 text-[12px] font-medium text-rose-600">
              {error}
            </p>
          ) : null}

          <div
            className="mt-4 flex items-center justify-between gap-3 px-1"
            data-testid="org-chooser-actions"
          >
            <Link
              href="/organization"
              className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--dls-text-secondary)] transition-colors hover:text-[var(--dls-text-primary)] focus:outline-none focus:ring-4 focus:ring-slate-950/5"
            >
              <Plus className="h-4 w-4" /> Create or join
            </Link>
            <button
              type="button"
              onClick={onSignOut}
              className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--dls-text-secondary)] transition-colors hover:text-[var(--dls-text-primary)] focus:outline-none focus:ring-4 focus:ring-slate-950/5"
            >
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
