"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { useDenFlow } from "../../../../_providers/den-flow-provider";
import {
  formatRoleLabel,
  getBackgroundAgentsRoute,
  getCustomLlmProvidersRoute,
  getMembersRoute,
  getOrgDashboardRoute,
  getSharedSetupsRoute,
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
    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#011627] text-xs font-semibold uppercase tracking-[0.08em] text-white">
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
    { href: activeOrg ? getSharedSetupsRoute(activeOrg.slug) : "#", label: "Shared setups" },
    { href: activeOrg ? getMembersRoute(activeOrg.slug) : "#", label: "Members" },
    { href: activeOrg ? getBackgroundAgentsRoute(activeOrg.slug) : "#", label: "Background agents", badge: "Alpha" },
    { href: activeOrg ? getCustomLlmProvidersRoute(activeOrg.slug) : "#", label: "Custom LLM providers", badge: "Soon" },
  ];
  const billingNavItem = { href: "/checkout", label: "Billing" };
  const dashboardHref = activeOrg ? getOrgDashboardRoute(activeOrg.slug) : "#";

  return (
    <section className="flex min-h-screen min-h-dvh w-full gap-3 bg-[var(--dls-app-bg)] p-3 md:flex-row md:gap-4 md:p-4">
      <aside className="w-full shrink-0 rounded-[2rem] border border-[#eceef1] bg-[#fafafa] md:h-[calc(100dvh-2rem)] md:max-h-[calc(100dvh-2rem)] md:w-[304px] md:self-start">
        <div className="flex h-full flex-col gap-5 overflow-y-auto p-4 md:p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="den-eyebrow">OpenWork Cloud</p>
            {orgBusy ? <span className="text-xs text-[var(--dls-text-secondary)]">Refreshing...</span> : null}
          </div>

          <div className="relative">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 rounded-[1.35rem] px-3 py-3 text-left transition-colors hover:bg-[#f3f4f6]"
              onClick={() => setSwitcherOpen((current) => !current)}
            >
              <div className="flex min-w-0 items-center gap-3">
                <OrgMark name={activeOrg?.name ?? "OpenWork"} />
                <div className="min-w-0">
                  <p className="den-eyebrow">Organization</p>
                  <p className="truncate text-base font-semibold tracking-tight text-[var(--dls-text-primary)]">
                    {activeOrg?.name ?? "Loading..."}
                  </p>
                  <p className="truncate text-xs text-[var(--dls-text-secondary)]">
                    {activeOrg ? formatRoleLabel(activeOrg.role) : "Preparing workspace"}
                  </p>
                </div>
              </div>
              <span className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--dls-text-secondary)]">
                <ChevronDownIcon />
              </span>
            </button>

            {switcherOpen ? (
              <div className="absolute left-0 right-0 top-[calc(100%+0.75rem)] z-30 grid gap-4 rounded-[1.75rem] border border-[#eceef1] bg-white p-4 shadow-[0_12px_32px_-24px_rgba(15,23,42,0.18)]">
                <div className="grid gap-2">
                  <p className="den-eyebrow">Switch organization</p>
                  <div className="grid gap-2">
                    {orgDirectory.map((org) => (
                      <button
                        key={org.id}
                        type="button"
                        onClick={() => {
                          setSwitcherOpen(false);
                          switchOrganization(org.slug);
                        }}
                        className={`flex items-center justify-between gap-3 rounded-[1.2rem] px-4 py-3 text-left transition-colors ${
                          org.isActive
                            ? "bg-[#f3f4f6] text-[var(--dls-text-primary)]"
                            : "text-[var(--dls-text-secondary)] hover:bg-[#f6f7f8] hover:text-[var(--dls-text-primary)]"
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold">{org.name}</span>
                          <span className="block truncate text-xs">{formatRoleLabel(org.role)}</span>
                        </span>
                        {org.isActive ? <span className="den-status-pill is-neutral">Current</span> : null}
                      </button>
                    ))}
                  </div>
                </div>

                <form
                  className="grid gap-3 rounded-[1.5rem] border border-[#eceef1] bg-[#f7f8fa] p-4"
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
                    <span className="den-label">Create organization</span>
                    <input
                      type="text"
                      value={orgNameDraft}
                      onChange={(event) => setOrgNameDraft(event.target.value)}
                      placeholder="Acme Labs"
                      className="den-input"
                    />
                  </label>
                  <button
                    type="submit"
                    className="den-button-primary"
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

          <div className="grid gap-3">
            <div className="px-2 pt-1">
              <p className="den-eyebrow">Navigation</p>
            </div>
            <nav className="grid gap-1.5">
              {navItems.map((item) => {
                const selected = item.href !== "#" && (item.href === dashboardHref ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`));
                return (
                  <Link
                    key={item.label}
                    href={item.href}
                    className={`flex items-center justify-between gap-3 rounded-[1.2rem] px-4 py-3 text-sm transition-colors ${
                      selected
                        ? "bg-[#f0f1f3] font-medium text-[var(--dls-text-primary)]"
                        : "text-[var(--dls-text-secondary)] hover:bg-[#f6f7f8] hover:text-[var(--dls-text-primary)]"
                    }`}
                  >
                    <span>{item.label}</span>
                    {item.badge ? <span className="rounded-full bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--dls-text-secondary)]">{item.badge}</span> : null}
                  </Link>
                );
              })}
            </nav>

            <div className="pt-2">
              <Link
                href={billingNavItem.href}
                className={`flex items-center justify-between gap-3 rounded-[1.2rem] px-4 py-3 text-sm transition-colors ${
                  pathname === billingNavItem.href
                    ? "bg-[#f0f1f3] font-medium text-[var(--dls-text-primary)]"
                    : "text-[var(--dls-text-secondary)] hover:bg-[#f6f7f8] hover:text-[var(--dls-text-primary)]"
                }`}
              >
                <span>{billingNavItem.label}</span>
              </Link>
            </div>
          </div>

          <div className="mt-auto grid gap-3">
            <a
              href="https://openworklabs.com/docs"
              target="_blank"
              rel="noreferrer"
              className="flex min-h-[56px] w-full items-center justify-center rounded-[1.6rem] border border-[#eceef1] bg-white px-4 text-sm font-medium text-[var(--dls-text-secondary)] shadow-[0_4px_16px_-14px_rgba(15,23,42,0.15)] transition-colors hover:text-[var(--dls-text-primary)]"
            >
              Learn how
            </a>

            <div className="grid gap-3 rounded-[1.6rem] border border-[#eceef1] bg-white p-4 shadow-[0_4px_16px_-14px_rgba(15,23,42,0.12)]">
              <div>
                <p className="den-eyebrow">Signed in as</p>
                <p className="mt-2 break-words text-sm font-medium text-[var(--dls-text-primary)]">
                  {user?.email ?? "Unknown user"}
                </p>
                {orgError ? <p className="mt-3 text-xs font-medium text-rose-600">{orgError}</p> : null}
              </div>
              <button
                type="button"
                className="flex min-h-[48px] w-full items-center justify-center rounded-[1.2rem] bg-[#f5f6f7] px-4 text-sm font-medium text-[var(--dls-text-secondary)] transition-colors hover:text-[var(--dls-text-primary)]"
                onClick={() => void signOut()}
              >
                Log out
              </button>
            </div>
          </div>
        </div>
      </aside>

      <main className="min-h-screen min-h-dvh flex-1 overflow-hidden rounded-[2rem] border border-[#eceef1] bg-white">
        {children}
      </main>
    </section>
  );
}
