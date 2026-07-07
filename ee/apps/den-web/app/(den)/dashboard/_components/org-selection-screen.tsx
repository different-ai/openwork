"use client";

import Link from "next/link";
import { Building2, ChevronRight, LogOut, Plus } from "lucide-react";
import { formatRoleLabel, type DenOrgSummary } from "../../_lib/den-org";
import { useOrgListWindow } from "../../_lib/use-org-list-window";

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

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#fafafa] px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-[18px] font-semibold tracking-[-0.2px] text-gray-900">
            Choose an organization
          </h1>
          <p className="mt-1 text-[13px] text-gray-500">
            You belong to {orgs.length} organizations. Select one to continue.
          </p>
        </div>

        {showSearch ? (
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search organizations"
            className="mb-3 w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-[13px] text-gray-900 outline-none transition focus:border-gray-400 focus:ring-4 focus:ring-gray-900/5"
          />
        ) : null}

        <div className="grid gap-2 rounded-xl border border-gray-200 bg-white p-2 shadow-[0_12px_24px_-16px_rgba(0,0,0,0.15)]">
          {visible.map((org) => (
            <button
              key={org.id}
              type="button"
              disabled={busy}
              onClick={() => onSelect(org.slug)}
              className="flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-500">
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
          <p className="mt-3 px-1 text-[13px] text-gray-500">No organizations match your search.</p>
        ) : null}

        {hasMore ? (
          <div className="mt-3 flex items-center justify-between gap-3 px-1">
            <p className="text-[12px] text-gray-500">
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
          <p className="mt-3 px-1 text-[12px] font-medium text-rose-600">{error}</p>
        ) : null}

        <div className="mt-4 flex items-center justify-between px-1">
          <Link
            href="/organization"
            className="flex items-center gap-1.5 text-[13px] font-medium text-gray-600 transition-colors hover:text-gray-900"
          >
            <Plus className="h-4 w-4 text-gray-400" /> Create or join
          </Link>
          <button
            type="button"
            onClick={onSignOut}
            className="flex items-center gap-1.5 text-[13px] font-medium text-gray-600 transition-colors hover:text-gray-900"
          >
            <LogOut className="h-4 w-4 text-gray-400" /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
