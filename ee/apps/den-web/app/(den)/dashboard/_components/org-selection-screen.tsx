"use client";

import { Dithering } from "@paper-design/shaders-react";
import Link from "next/link";
import { Building2, ChevronRight, LogOut, Plus } from "lucide-react";
import { useSyncExternalStore } from "react";
import { formatRoleLabel, type DenOrgSummary } from "../../_lib/den-org";
import { useOrgListWindow } from "../../_lib/use-org-list-window";
import { useWebGlSupported } from "../../_lib/use-webgl-supported";

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

/**
 * Organization picker after Den sign-in.
 * Layout mirrors the desktop OpenWork forced sign-in / welcome card:
 * dither field + centered branded card + left-aligned headline + full-width actions.
 */
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
  const webGlSupported = useWebGlSupported();
  const shaderSpeed = reducedMotion ? 0 : 0.01;

  return (
    <section
      className="relative isolate min-h-dvh overflow-y-auto bg-[var(--dls-surface)] text-[var(--dls-text-primary)]"
      data-testid="org-chooser-root"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 overflow-hidden opacity-[0.1]"
        data-motion={shaderSpeed === 0 ? "reduced" : "ambient"}
        data-shader-speed={shaderSpeed}
        data-testid="org-chooser-background"
      >
        {webGlSupported ? (
          <Dithering
            speed={shaderSpeed}
            shape="warp"
            type="2x2"
            size={20.3}
            scale={1.19}
            frame={264559.21}
            colorBack="#00000000"
            colorFront="#000000"
            style={{ width: "100%", height: "100%" }}
          />
        ) : null}
      </div>

      <div
        className="relative z-10 flex min-h-dvh items-center justify-center px-6 py-16"
        data-testid="org-chooser-foreground"
      >
        <div className="w-full max-w-[720px] rounded-3xl border border-[var(--dls-border)] bg-[var(--dls-surface)] px-8 pb-12 pt-10 sm:px-16 sm:pb-16 sm:pt-14">
          <div className="flex items-center gap-2.5">
            <img
              src="/openwork-mark.svg"
              alt=""
              width={26}
              height={26}
              className="max-h-[26px] shrink-0 object-contain object-left"
              aria-hidden="true"
            />
            <span className="text-[15px] font-semibold tracking-tight text-[var(--dls-text-primary)]">
              OpenWork
            </span>
          </div>

          <div className="mt-10 flex flex-col gap-2.5 sm:mt-14">
            <h1 className="text-[30px] font-semibold leading-[38px] tracking-[-0.03em] text-[var(--dls-text-primary)] sm:text-[38px] sm:leading-[46px]">
              Choose an organization
            </h1>
            <p className="text-[15px] leading-[23px] text-[var(--dls-text-secondary)]">
              You belong to {orgs.length}{" "}
              {orgs.length === 1 ? "organization" : "organizations"}. Select one
              to continue.
            </p>
          </div>

          <div className="mt-11 flex flex-col gap-3">
            {showSearch ? (
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search organizations"
                className="h-12 w-full rounded-xl border border-[var(--dls-border)] bg-[var(--dls-surface)] px-4 text-[15px] text-[var(--dls-text-primary)] placeholder:text-[var(--dls-text-secondary)] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
              />
            ) : null}

            <div
              className="flex flex-col gap-2"
              data-testid="org-chooser-list"
            >
              {visible.map((org) => (
                <button
                  key={org.id}
                  type="button"
                  disabled={busy}
                  onClick={() => onSelect(org.slug)}
                  className="flex items-center gap-3 rounded-xl border border-[var(--dls-border)] bg-[var(--dls-surface)] px-4 py-3.5 text-left transition-colors hover:border-[var(--dls-text-primary)]/20 hover:bg-[var(--dls-hover)] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--dls-hover)] text-[var(--dls-text-secondary)]">
                    <Building2 className="h-4 w-4" strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium text-[var(--dls-text-primary)]">
                      {org.name}
                    </span>
                    <span className="block truncate text-[13px] text-[var(--dls-text-secondary)]">
                      {formatRoleLabel(org.role)} · {org.memberCount}{" "}
                      {org.memberCount === 1 ? "member" : "members"}
                    </span>
                  </span>
                  <ChevronRight
                    className="h-4 w-4 shrink-0 text-[var(--dls-text-secondary)]"
                    strokeWidth={2}
                  />
                </button>
              ))}
            </div>

            {filteredCount === 0 && query ? (
              <p className="text-[14px] text-[var(--dls-text-secondary)]">
                No organizations match your search.
              </p>
            ) : null}

            {hasMore ? (
              <div className="flex flex-col items-start gap-2">
                <button
                  type="button"
                  onClick={showMore}
                  className="inline-flex h-9 items-center justify-center rounded-full border border-[var(--dls-border)] bg-[var(--dls-surface)] px-4 text-[13px] font-medium text-[var(--dls-text-primary)] transition-colors hover:bg-[var(--dls-hover)]"
                >
                  Show more
                </button>
                <p className="text-[12px] text-[var(--dls-text-secondary)]">
                  Showing {visible.length} of {filteredCount} organizations
                </p>
              </div>
            ) : null}

            {error ? (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
                {error}
              </div>
            ) : null}

            <div
              className="mt-2 flex flex-wrap items-center gap-2"
              data-testid="org-chooser-actions"
            >
              <Link
                href="/organization"
                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full border border-[var(--dls-border)] bg-[var(--dls-surface)] px-4 text-[13px] font-medium text-[var(--dls-text-primary)] transition-colors hover:bg-[var(--dls-hover)] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
              >
                <Plus className="h-4 w-4" /> Create or join
              </Link>
              <button
                type="button"
                onClick={onSignOut}
                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full border border-[var(--dls-border)] bg-[var(--dls-surface)] px-4 text-[13px] font-medium text-[var(--dls-text-secondary)] transition-colors hover:bg-[var(--dls-hover)] hover:text-[var(--dls-text-primary)] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
              >
                <LogOut className="h-4 w-4" /> Sign out
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
