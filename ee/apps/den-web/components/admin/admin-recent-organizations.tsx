"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Clock3, X } from "lucide-react";

// Per-browser convenience only. Entries hold an organization's id, name and
// slug, and render only inside pages that already passed the admin access check.
const STORAGE_KEY = "den-admin-recent-organizations";
const CHANGE_EVENT = "den-admin-recent-organizations-change";
const MAX_ENTRIES = 8;

export type AdminRecentOrganization = { id: string; name: string; slug: string | null; visitedAt: string };

function readEntries(): AdminRecentOrganization[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const { id, name, slug, visitedAt } = entry as Record<string, unknown>;
      if (typeof id !== "string" || typeof name !== "string" || typeof visitedAt !== "string") return [];
      return [{ id, name, slug: typeof slug === "string" ? slug : null, visitedAt }];
    }).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function writeEntries(entries: AdminRecentOrganization[]) {
  try {
    if (entries.length) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch { /* Storage is optional. */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function recordAdminOrganizationVisit(organization: { id: string; name: string; slug?: string | null }) {
  const entries = readEntries().filter((entry) => entry.id !== organization.id);
  writeEntries([{ id: organization.id, name: organization.name, slug: organization.slug ?? null, visitedAt: new Date().toISOString() }, ...entries].slice(0, MAX_ENTRIES));
}

export function useAdminRecentOrganizations() {
  // Read after mount so server and first client render agree.
  const [entries, setEntries] = useState<AdminRecentOrganization[]>([]);
  useEffect(() => {
    const sync = () => setEntries(readEntries());
    sync();
    const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY) sync(); };
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => { window.removeEventListener(CHANGE_EVENT, sync); window.removeEventListener("storage", onStorage); };
  }, []);
  const remove = useCallback((id: string) => writeEntries(readEntries().filter((entry) => entry.id !== id)), []);
  const clear = useCallback(() => writeEntries([]), []);
  return { entries, remove, clear };
}

function visitedLabel(value: string) {
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

const organizationHref = (id: string) => `/admin/organizations/${encodeURIComponent(id)}`;

/** Overview panel: a short list with when each organization was last opened. */
export function AdminRecentOrganizationsPanel() {
  const { entries, remove, clear } = useAdminRecentOrganizations();
  return <section aria-label="Recently viewed organizations" data-testid="admin-recent-organizations" className="min-w-0 rounded-lg border border-slate-200 bg-white">
    <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-950"><Clock3 size={15} strokeWidth={1.75} aria-hidden="true" className="text-slate-500" />Recently viewed</h2>
      {entries.length ? <button type="button" onClick={clear} className="rounded px-1.5 py-0.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900">Clear</button> : null}
    </div>
    {entries.length ? <ul className="divide-y divide-slate-100">
      {entries.slice(0, 6).map((entry) => {
        const when = visitedLabel(entry.visitedAt);
        return <li key={entry.id} className="group flex min-w-0 items-center gap-2 px-4 py-2.5 hover:bg-slate-50">
          <Link href={organizationHref(entry.id)} prefetch={false} aria-label={`${entry.name}, viewed ${when}`} className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-slate-900 group-hover:underline">{entry.name}</span>
            <span className="block truncate text-xs text-slate-500">{entry.slug && entry.slug !== entry.id ? `/${entry.slug} · ` : ""}{when}</span>
          </Link>
          <button type="button" aria-label={`Remove ${entry.name} from recently viewed`} onClick={() => remove(entry.id)}
            className="shrink-0 rounded p-1 text-slate-500 opacity-0 transition hover:bg-slate-200 hover:text-slate-700 focus-visible:opacity-100 group-hover:opacity-100">
            <X size={14} aria-hidden="true" />
          </button>
        </li>;
      })}
    </ul> : <p className="px-4 py-6 text-sm text-slate-500">Organizations you open appear here so you can jump back quickly.</p>}
  </section>;
}

/** Organization list: compact chips above the search results. */
export function AdminRecentOrganizationsStrip() {
  const { entries } = useAdminRecentOrganizations();
  if (!entries.length) return null;
  return <nav aria-label="Recently viewed organizations" data-testid="admin-recent-organizations-strip" className="flex min-w-0 flex-wrap items-center gap-2">
    <span className="flex items-center gap-1.5 text-xs font-medium text-slate-500"><Clock3 size={13} strokeWidth={1.75} aria-hidden="true" />Recent</span>
    {entries.slice(0, 5).map((entry) => <Link key={entry.id} href={organizationHref(entry.id)} prefetch={false} aria-label={`${entry.name}, viewed ${visitedLabel(entry.visitedAt)}`}
      className="max-w-[14rem] truncate rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-950">
      {entry.name}
    </Link>)}
  </nav>;
}
