"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { useDenFlow } from "../../../../_providers/den-flow-provider";
import {
  formatRoleLabel,
  getManageMembersRoute,
  getOrgDashboardRoute,
} from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="m2 4 4 4 4-4" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
      <path d="M8 3v10" />
      <path d="M3 8h10" />
    </svg>
  );
}

function OrgMark({ name }: { name: string }) {
  const initials = useMemo(() => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    return (parts[0]?.slice(0, 1) ?? "O") + (parts[1]?.slice(0, 1) ?? "");
  }, [name]);

  return (
    <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#011627,#334155)] text-sm font-semibold uppercase tracking-[0.08em] text-white shadow-[0_18px_40px_-18px_rgba(1,22,39,0.45)]">
      {initials}
    </div>
  );
}

export function OrgDashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, signOut } = useDenFlow();
  const {
    activeOrg,
    orgDirectory,
    orgBusy,
    orgError,
    mutationBusy,
    createOrganization,
    switchOrganization,
  } = useOrgDashboard();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [orgNameDraft, setOrgNameDraft] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const navItems = [
    { href: activeOrg ? getOrgDashboardRoute(activeOrg.slug) : "#", label: "Dashboard" },
    { href: activeOrg ? getManageMembersRoute(activeOrg.slug) : "#", label: "Manage Members" },
    { href: "/checkout", label: "Billing" },
  ];

  return (
    <section className="flex min-h-screen min-h-dvh w-full overflow-hidden bg-[var(--dls-surface)] md:flex-row">
      <aside className="w-full shrink-0 border-b border-[var(--dls-border)] bg-[var(--dls-sidebar)] md:w-[320px] md:border-b-0 md:border-r">
        <div className="flex h-full flex-col gap-6 p-4 md:p-6">
          <div className="relative">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 rounded-[28px] border border-[var(--dls-border)] bg-white px-4 py-4 text-left shadow-[var(--dls-card-shadow)] transition hover:border-slate-300"
              onClick={() => setSwitcherOpen((current) => !current)}
            >
              <div className="flex min-w-0 items-center gap-3">
                <OrgMark name={activeOrg?.name ?? "OpenWork"} />
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--dls-text-secondary)]">Organization</p>
                  <p className="truncate text-lg font-semibold tracking-tight text-[var(--dls-text-primary)]">{activeOrg?.name ?? "Loading..."}</p>
                  <p className="truncate text-xs text-[var(--dls-text-secondary)]">{activeOrg ? formatRoleLabel(activeOrg.role) : "Preparing workspace"}</p>
                </div>
              </div>
              <span className="rounded-full border border-[var(--dls-border)] bg-[var(--dls-surface)] p-2 text-[var(--dls-text-secondary)]">
                <ChevronDownIcon />
              </span>
            </button>

            {switcherOpen ? (
              <div className="absolute left-0 right-0 top-[calc(100%+0.75rem)] z-30 rounded-[28px] border border-[var(--dls-border)] bg-white p-4 shadow-[0_30px_80px_-30px_rgba(15,23,42,0.28)]">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--dls-text-secondary)]">Switch organization</p>
                  {orgBusy ? <span className="text-xs text-[var(--dls-text-secondary)]">Refreshing...</span> : null}
                </div>

                <div className="grid gap-2">
                  {orgDirectory.map((org) => (
                    <button
                      key={org.id}
                      type="button"
                      onClick={() => {
                        setSwitcherOpen(false);
                        switchOrganization(org.slug);
                      }}
                      className={`flex items-center justify-between rounded-2xl border px-3 py-3 text-left transition ${
                        org.isActive ? "border-slate-300 bg-slate-50" : "border-transparent hover:border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-[var(--dls-text-primary)]">{org.name}</span>
                        <span className="block truncate text-xs text-[var(--dls-text-secondary)]">{formatRoleLabel(org.role)}</span>
                      </span>
                      {org.isActive ? <span className="rounded-full bg-slate-900 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white">Current</span> : null}
                    </button>
                  ))}
                </div>

                <form
                  className="mt-4 grid gap-2 rounded-2xl border border-[var(--dls-border)] bg-[var(--dls-sidebar)] p-3"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    setCreateError(null);
                    try {
                      await createOrganization(orgNameDraft);
                      setOrgNameDraft("");
                      setSwitcherOpen(false);
                    } catch (error) {
                      setCreateError(error instanceof Error ? error.message : "Could not create organization.");
                    }
                  }}
                >
                  <label className="grid gap-2">
                    <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--dls-text-secondary)]">Create new organization</span>
                    <input
                      type="text"
                      value={orgNameDraft}
                      onChange={(event) => setOrgNameDraft(event.target.value)}
                      placeholder="Acme Labs"
                      className="rounded-2xl border border-[var(--dls-border)] bg-white px-4 py-3 text-sm text-[var(--dls-text-primary)] outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-900/5"
                    />
                  </label>
                  <button
                    type="submit"
                    className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[#011627] px-4 py-3 text-sm font-semibold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={mutationBusy === "create-organization"}
                  >
                    <PlusIcon />
                    {mutationBusy === "create-organization" ? "Creating..." : "Create organization"}
                  </button>
                  {createError ? <p className="text-xs font-medium text-rose-600">{createError}</p> : null}
                </form>
              </div>
            ) : null}
          </div>

          <div className="rounded-[28px] border border-[var(--dls-border)] bg-white p-4 shadow-[var(--dls-card-shadow)]">
            <div className="mb-4 flex items-center gap-3">
              <OrgMark name={activeOrg?.name ?? "OpenWork"} />
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--dls-text-secondary)]">Den workspace</p>
                <p className="text-sm font-medium text-[var(--dls-text-secondary)]">Branding and membership controls live here.</p>
              </div>
            </div>

            <nav className="grid gap-1.5">
              {navItems.map((item) => {
                const selected = item.href !== "#" && pathname === item.href;
                return (
                  <Link
                    key={item.label}
                    href={item.href}
                    className={`rounded-2xl px-4 py-3 text-sm font-medium transition ${
                      selected
                        ? "bg-[var(--dls-active)] text-[var(--dls-text-primary)]"
                        : "text-[var(--dls-text-secondary)] hover:bg-[var(--dls-hover)] hover:text-[var(--dls-text-primary)]"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="mt-auto rounded-[28px] border border-[var(--dls-border)] bg-white p-4 shadow-[var(--dls-card-shadow)]">
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--dls-text-secondary)]">Signed in as</p>
            <p className="mt-2 truncate text-sm font-medium text-[var(--dls-text-primary)]">{user?.email ?? "Unknown user"}</p>
            {orgError ? <p className="mt-3 text-xs font-medium text-rose-600">{orgError}</p> : null}
            <button
              type="button"
              className="mt-4 inline-flex w-full items-center justify-center rounded-2xl border border-[var(--dls-border)] bg-[var(--dls-surface)] px-4 py-3 text-sm font-medium text-[var(--dls-text-secondary)] transition hover:bg-[var(--dls-hover)] hover:text-[var(--dls-text-primary)]"
              onClick={() => void signOut()}
            >
              Log out
            </button>
          </div>
        </div>
      </aside>

      <main className="min-h-screen min-h-dvh flex-1">{children}</main>
    </section>
  );
}
