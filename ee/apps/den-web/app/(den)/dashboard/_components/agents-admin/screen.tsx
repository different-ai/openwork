"use client";

import { notFound } from "next/navigation";
import { DenButton } from "../../../_components/ui/button";
import { DashboardPageTemplate } from "../../../_components/ui/dashboard-page-template";
import { DenNotice } from "../../../_components/ui/notice";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { getOrgAccessFlags, orgFeatureEnabled, type DenOrgContext } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { formatRelativeTime } from "../config-blobs/config-blobs-model";
import { useAdminAgentEvents, useAdminAgents } from "./data";
import { OrgAgentPolicy } from "./policy";
import { AgentTable } from "./rows";
import { agentEventSentence, formatAgentMoney } from "./words";

const muted = "text-[13px] text-[var(--dls-text-secondary)]";
const divider = "border-[var(--dls-border)]";

function LoadError({ message, retry }: { message: string; retry: () => void }) {
  return <div className="space-y-2">
    <DenNotice tone="error" message={message} />
    <DenButton variant="secondary" size="sm" onClick={retry}>Try again</DenButton>
  </div>;
}

function AgentEvents({ orgId }: { orgId: string }) {
  const events = useAdminAgentEvents(orgId);
  const items = events.data?.items;
  const now = Date.now();
  return <section data-agents-events="" aria-labelledby="agents-events-title" aria-busy={events.isPending} className="space-y-3">
    <h2 id="agents-events-title" className="text-base font-semibold">Who changed what</h2>
    {events.isError ? <LoadError message="Could not refresh changes to agents." retry={() => void events.refetch()} /> : null}
    {events.isPending ? <DenSkeleton className="h-24 w-full" /> : null}
    {items?.length === 0 ? <p className={muted}>No changes yet.</p> : null}
    {items?.length ? <ol className={`divide-y divide-[var(--dls-border)] border-y ${divider}`}>
      {items.map((event) => {
        const stamp = new Date(event.createdAt);
        const iso = stamp.toISOString();
        return <li key={event.id} data-agents-event="" className="py-2 text-[13px] leading-5">
          <time dateTime={iso} title={stamp.toLocaleString()} className="text-[var(--dls-text-secondary)]">{formatRelativeTime(iso, now)}</time>
          <span className="text-[var(--dls-text-secondary)]"> · </span>
          <span className="font-medium">{event.actor.name || "A member"}</span>{" "}{agentEventSentence(event.action, event.detail, event.agentName)}
        </li>;
      })}
    </ol> : null}
  </section>;
}

function AgentsAdmin({ org }: { org: DenOrgContext }) {
  const orgId = org.organization.id;
  const agents = useAdminAgents(orgId);
  const list = agents.data;
  return <div data-agents-admin="">
    <DashboardPageTemplate title="Agents" description={`Every personal agent in ${org.organization.name}. Members set them up in the OpenWork app.`}
      action={list ? <p className="text-[13px] font-medium tabular-nums">{formatAgentMoney(list.monthMicros)} this month</p> : null}>
      <div className="space-y-8">
        {agents.isError ? <LoadError message="Could not refresh the list of agents." retry={() => void agents.refetch()} /> : null}
        {agents.isPending ? <div aria-busy="true"><DenSkeleton className="h-32 w-full" /></div> : null}
        {list ? <>
          <AgentTable org={org} items={list.items} />
          <OrgAgentPolicy orgId={orgId} policy={list.policy} />
        </> : null}
        <AgentEvents orgId={orgId} />
      </div>
    </DashboardPageTemplate>
  </div>;
}

export function AgentsAdminRoute() {
  const { orgBusy, orgContext } = useOrgDashboard();
  if (orgBusy || !orgContext) return null;
  if (!orgFeatureEnabled(orgContext, "personalAgents")) notFound();
  const { role, isOwner, permissions } = orgContext.currentMember;
  if (!getOrgAccessFlags(role, isOwner, permissions).isAdmin) notFound();
  return <AgentsAdmin key={orgContext.organization.id} org={orgContext} />;
}
