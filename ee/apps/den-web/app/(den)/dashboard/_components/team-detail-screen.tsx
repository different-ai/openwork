"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, ShieldCheck, Users } from "lucide-react";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { type TabItem, UnderlineTabs } from "../../_components/ui/tabs";
import { getMarketplaceRoute, getMembersRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { OrgMemberIdentity } from "./org-member-identity";
import {
  type TeamPluginAccessItem,
  useRevokeTeamPluginAccess,
  useTeamPluginAccess,
} from "./team-access-data";

type TeamDetailTab = "overview" | "access";

function formatGrantedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function AccessViaBadge({ item }: { item: TeamPluginAccessItem }) {
  if (item.edge === "direct_team") {
    return <DenBadge tone="success">direct team grant</DenBadge>;
  }
  if (item.edge === "via_catalog") {
    return <DenBadge tone="info">via catalog: {item.marketplace?.name}</DenBadge>;
  }
  return (
    <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-1 text-[12px] font-medium text-emerald-600">
      org-wide
    </span>
  );
}

function RoleBadge({ role }: { role: TeamPluginAccessItem["role"] }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-medium ${
        role === "editor"
          ? "border border-amber-200 bg-amber-50 text-amber-700"
          : "bg-gray-100 text-gray-600"
      }`}
    >
      {role}
    </span>
  );
}

export function TeamDetailScreen({ teamId }: { teamId: string }) {
  const { orgContext, orgSlug } = useOrgDashboard();
  const [activeTab, setActiveTab] = useState<TeamDetailTab>("access");
  const accessQuery = useTeamPluginAccess(teamId);
  const revokeAccess = useRevokeTeamPluginAccess();
  const team = orgContext?.teams.find((entry) => entry.id === teamId);
  const membersById = new Map((orgContext?.members ?? []).map((member) => [member.id, member]));
  const teamMembers = (team?.memberIds ?? []).flatMap((memberId) => {
    const member = membersById.get(memberId);
    return member ? [member] : [];
  });
  const memberCount = team?.memberIds.length ?? 0;
  const tabs: readonly TabItem<TeamDetailTab>[] = [
    { value: "overview", label: "Overview", icon: Users },
    { value: "access", label: "Access", icon: ShieldCheck },
  ];

  return (
    <div className="mx-auto max-w-[860px] px-6 py-8 md:px-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <Link
          href={getMembersRoute(orgSlug)}
          className="inline-flex items-center gap-1.5 text-[13px] text-gray-400 transition hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
      </div>

      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-[24px] font-semibold tracking-[-0.04em] text-gray-950">
          {team?.name ?? "Team"}
        </h1>
        <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[12px] font-medium text-gray-600">
          {memberCount} {memberCount === 1 ? "member" : "members"}
        </span>
      </header>

      <UnderlineTabs
        className="mt-6"
        tabs={tabs}
        activeTab={activeTab}
        onChange={setActiveTab}
      />

      <div className="mt-6">
        {activeTab === "overview" ? (
          <div role="tabpanel" aria-label="Overview">
            {teamMembers.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
                <p className="text-[14px] font-medium text-gray-800">This team has no members yet.</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100 rounded-2xl border border-gray-100 bg-white">
                {teamMembers.map((member) => (
                  <div key={member.id} className="px-6 py-4">
                    <OrgMemberIdentity member={member} />
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {activeTab === "access" ? (
          <div role="tabpanel" aria-label="Access">
            {accessQuery.isLoading ? (
              <div className="rounded-2xl border border-gray-100 bg-white px-6 py-8 text-[13px] text-gray-400">
                Loading team access…
              </div>
            ) : accessQuery.error ? (
              <DenNotice
                tone="error"
                message={accessQuery.error instanceof Error ? accessQuery.error.message : "Could not load team access."}
              />
            ) : accessQuery.data?.length ? (
              <div className="overflow-hidden rounded-2xl md:border md:border-gray-100 md:bg-white md:overflow-x-auto">
                <div className="md:min-w-[760px]">
                  <div className="hidden grid-cols-[minmax(0,1fr)_210px_100px_230px_110px] border-b border-gray-100 px-6 py-3 text-[11px] uppercase tracking-[0.14em] text-gray-400 md:grid">
                    <span>Plugin</span>
                    <span>Access via</span>
                    <span>Role</span>
                    <span>Granted by</span>
                    <span />
                  </div>
                  <div className="space-y-3 md:space-y-0 md:divide-y md:divide-gray-100">
                    {accessQuery.data.map((item) => {
                      const revoking = revokeAccess.isPending && revokeAccess.variables?.grantId === item.grantId;
                      return (
                        <div
                          key={`${item.plugin.id}-${item.edge}-${item.grantId ?? item.marketplace?.id ?? "org"}`}
                          className={`flex flex-col gap-3 rounded-2xl border border-gray-100 bg-white px-4 py-4 md:grid md:grid-cols-[minmax(0,1fr)_210px_100px_230px_110px] md:items-center md:gap-0 md:rounded-none md:border-0 md:px-6 md:py-3.5 ${item.role === "editor" ? "bg-amber-50/40" : ""}`}
                        >
                          <div className="min-w-0 md:pr-4">
                            <p className="truncate text-[14px] font-semibold text-gray-900">{item.plugin.name}</p>
                            <p className="mt-0.5 text-[12px] text-gray-400">
                              {item.plugin.componentCount} {item.plugin.componentCount === 1 ? "component" : "components"}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 md:contents">
                            <div className="md:pr-4">
                              <AccessViaBadge item={item} />
                            </div>
                            <div>
                              <RoleBadge role={item.role} />
                            </div>
                          </div>
                          <p className="text-[13px] text-gray-500 md:pr-4">
                            {item.grantedBy?.name ?? "—"} · {formatGrantedDate(item.grantedAt)}
                          </p>
                          {item.edge === "direct_team" ? (
                            <div className="flex justify-end border-t border-gray-100 pt-3 md:border-0 md:pt-0">
                              <DenButton
                                variant="destructive"
                                size="sm"
                                disabled={!item.grantId}
                                loading={revoking}
                                onClick={() => {
                                  if (!item.grantId) return;
                                  revokeAccess.mutate({
                                    teamId,
                                    pluginId: item.plugin.id,
                                    grantId: item.grantId,
                                  });
                                }}
                              >
                                Revoke
                              </DenButton>
                            </div>
                          ) : item.edge === "via_catalog" && item.marketplace ? (
                            <div className="flex justify-end border-t border-gray-100 pt-3 md:border-0 md:pt-0">
                              <DenButton
                                href={getMarketplaceRoute(orgSlug, item.marketplace.id)}
                                variant="secondary"
                                size="sm"
                              >
                                Open catalog
                              </DenButton>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
                <p className="text-[14px] font-medium text-gray-800">This team has no plugin access yet.</p>
              </div>
            )}

            {revokeAccess.error ? (
              <DenNotice
                className="mt-4"
                tone="error"
                message={revokeAccess.error instanceof Error ? revokeAccess.error.message : "Could not revoke plugin access."}
              />
            ) : null}

            <p className="mt-4 text-[12px] text-gray-500">
              direct = revocable here; via catalog = manage in the catalog; org-wide = org setting.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
