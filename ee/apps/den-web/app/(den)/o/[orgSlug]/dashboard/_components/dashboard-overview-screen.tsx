"use client";

import Link from "next/link";
import {
  getBackgroundAgentsRoute,
  getCustomLlmProvidersRoute,
  getMembersRoute,
  getSharedSetupsRoute,
  getWorkersRoute,
} from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { OPENWORK_DOCS_URL, useOrgTemplates } from "./shared-setup-data";

export function DashboardOverviewScreen() {
  const { orgSlug, activeOrg, orgContext } = useOrgDashboard();
  const { templates, busy, error } = useOrgTemplates(orgSlug);
  const pendingInvitations = (orgContext?.invitations ?? []).filter((invitation) => invitation.status === "pending");

  return (
    <section className="den-page flex max-w-6xl flex-col gap-6 py-4 md:py-8">
      <div className="den-frame grid gap-6 p-6 md:p-8 lg:p-10">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="grid gap-3">
            <p className="den-eyebrow">OpenWork Cloud</p>
            <h1 className="den-title-xl max-w-[12ch]">{activeOrg?.name ?? "OpenWork Cloud"}</h1>
            <p className="den-copy max-w-2xl">
              Manage your team&apos;s setup, invite teammates, and keep everything in sync.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link href={getMembersRoute(orgSlug)} className="den-button-secondary">
              Add member
            </Link>
            <Link href={getWorkersRoute(orgSlug)} className="den-button-secondary">
              Open workers
            </Link>
            <a href={OPENWORK_DOCS_URL} target="_blank" rel="noreferrer" className="den-button-secondary">
              Learn how
            </a>
            <Link href="/checkout" className="den-button-primary">
              Billing
            </Link>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="den-stat-card">
            <p className="den-stat-label">Members</p>
            <p className="den-stat-value">{orgContext?.members.length ?? 0}</p>
            <p className="den-stat-copy">People who can access this shared setup.</p>
          </div>
          <div className="den-stat-card">
            <p className="den-stat-label">Shared setups</p>
            <p className="den-stat-value">{templates.length}</p>
            <p className="den-stat-copy">Reusable templates your team can open right away.</p>
          </div>
          <div className="den-stat-card">
            <p className="den-stat-label">Pending invites</p>
            <p className="den-stat-value">{pendingInvitations.length}</p>
            <p className="den-stat-copy">Invitations waiting for teammates to join.</p>
          </div>
        </div>
      </div>

      {error ? <div className="den-notice is-error">{error}</div> : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="den-list-shell">
          <div className="flex flex-col gap-2 px-5 py-5 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="den-eyebrow">Recent shared setups</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--dls-text-primary)]">
                Shared setups
              </h2>
            </div>
            <p className="max-w-sm text-sm leading-relaxed text-[var(--dls-text-secondary)] md:text-right">
              Create and update shared templates your team can use right away.
            </p>
          </div>

          {busy ? (
            <div className="den-list-row text-sm text-[var(--dls-text-secondary)]">Loading shared setups...</div>
          ) : templates.length === 0 ? (
            <div className="den-list-row text-sm text-[var(--dls-text-secondary)]">
              No shared setups yet. Create one from the OpenWork desktop app and it will appear here.
            </div>
          ) : (
            templates.slice(0, 4).map((template) => (
              <article key={template.id} className="den-list-row">
                <div className="grid gap-1">
                  <h3 className="text-base font-semibold text-[var(--dls-text-primary)]">{template.name}</h3>
                  <p className="text-sm text-[var(--dls-text-secondary)]">Created by {template.creator.name}</p>
                  <p className="text-xs text-[var(--dls-text-secondary)]">
                    {template.createdAt ? `Updated ${new Date(template.createdAt).toLocaleDateString()}` : "Updated recently"}
                  </p>
                </div>
                <Link href={getSharedSetupsRoute(orgSlug)} className="den-button-secondary shrink-0">
                  Open
                </Link>
              </article>
            ))
          )}
        </div>

        <div className="grid h-fit gap-4">
          <article className="den-frame-soft grid gap-3 p-5 md:p-6">
            <div className="flex items-center justify-between gap-3">
              <p className="den-eyebrow">Background agents</p>
              <span className="den-status-pill is-neutral">Alpha</span>
            </div>
            <p className="den-copy text-sm">Keep selected workflows running in the background.</p>
            <Link href={getBackgroundAgentsRoute(orgSlug)} className="den-button-secondary w-full">
              Open background agents
            </Link>
          </article>

          <article className="den-frame-soft grid gap-3 p-5 md:p-6">
            <div className="flex items-center justify-between gap-3">
              <p className="den-eyebrow">Custom LLM providers</p>
              <span className="den-status-pill is-neutral">Soon</span>
            </div>
            <p className="den-copy text-sm">Standardize provider access for your team.</p>
            <Link href={getCustomLlmProvidersRoute(orgSlug)} className="den-button-secondary w-full">
              Learn more
            </Link>
          </article>
        </div>
      </div>
    </section>
  );
}
