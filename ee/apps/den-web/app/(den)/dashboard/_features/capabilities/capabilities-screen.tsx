"use client";

import type { CustomerCapabilityId } from "@openwork/managed-deployments/capabilities";
import { LockKeyhole } from "lucide-react";
import { DenButton } from "../../../_components/ui/button";
import { DenChip } from "../../../_components/ui/chip";
import { DenNotice } from "../../../_components/ui/notice";
import { DenPageHeader } from "../../../_components/ui/page-header";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { DenTable, type DenTableColumn } from "../../../_components/ui/table";
import {
  getAiGatewayUsersTeamsRoute,
  getEveryoneRoute,
  getMcpConnectionRoute,
  getMcpConnectionsRoute,
  getOrgSettingsRoute,
  getWorkbotSettingsRoute,
  orgFeatureEnabled,
} from "../../../_lib/den-org";
import { ItemPage } from "../../_components/item-header";
import { SLACK_ASSISTANT_SECTION_ID } from "../../_components/slack-assistant-setup";
import { workbotSettingsInTeams } from "../../_lib/workbot-settings-rollout";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { useCapabilityMemberAccess } from "./capabilities-data";
import { ExplainedState } from "./capability-parts";
import { capabilityRows, memberAccessDetail, memberAccessLabel, type CapabilityRow, type MemberAccess } from "./capabilities-model";

export const CAPABILITIES_FEATURE = "deploymentCapabilitiesView";

function AccessCell({ row }: { row: CapabilityRow }) {
  const { access } = row;
  const testId = `capability-access-${row.id}`;
  if (access.kind === "loading") return <DenSkeleton className="h-[19px] w-20" data-testid={testId} aria-label="Checking member access" />;
  if (access.kind === "not_applicable") {
    return <span className="text-[13px] text-[var(--dls-text-secondary)]" data-testid={testId} data-access={access.kind} aria-label="Nothing to grant until it is installed">—</span>;
  }
  const label = memberAccessLabel(access);
  const detail = memberAccessDetail(access);
  if (access.kind === "locked") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] text-[var(--dls-text-secondary)]" data-testid={testId}>
        <LockKeyhole className="size-3.5 shrink-0" aria-hidden="true" />
        <span>{detail}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1" data-testid={testId} data-access={access.kind}>
      <DenChip tone={row.installedButOff ? "warning" : "neutral"}>{label}</DenChip>
      {detail ? <><span className="sr-only">, </span><span className="text-[12px] text-[var(--dls-text-secondary)]">{detail}</span></> : null}
    </span>
  );
}

function accessRoute(id: CustomerCapabilityId, orgSlug: string | null, workbotInTeams: boolean, slackConnectorId: string | null): string {
  switch (id) {
    case "workbot":
    case "cloudComputers": return workbotInTeams ? `${getEveryoneRoute(orgSlug)}?tab=workbot` : getWorkbotSettingsRoute(orgSlug);
    case "slackAssistant": return slackConnectorId ? `${getMcpConnectionRoute(orgSlug, slackConnectorId)}#${SLACK_ASSISTANT_SECTION_ID}` : getMcpConnectionsRoute(orgSlug);
    case "automations": return getOrgSettingsRoute(orgSlug);
    case "aiGateway": return getAiGatewayUsersTeamsRoute(orgSlug);
  }
}

function canManage(access: MemberAccess): boolean {
  return access.kind !== "locked" && access.kind !== "loading" && access.kind !== "not_applicable";
}

function installedButOffMessage(rows: readonly CapabilityRow[]): string | null {
  const names = rows.filter((row) => row.installedButOff).map((row) => row.label);
  if (names.length === 0) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} ${names.length === 1 ? "is" : "are"} installed, but no member can use ${names.length === 1 ? "it" : "them"} yet.`;
}

export function CapabilitiesScreen() {
  const { orgSlug, orgContext, orgBusy } = useOrgDashboard();
  const enabled = orgFeatureEnabled(orgContext, CAPABILITIES_FEATURE);
  const statuses = orgContext?.deploymentCapabilities.capabilities;
  const gatewayInstalled = statuses?.some((status) => status.id === "aiGateway" && status.state === "on") === true;
  const { access, slackConnectorId } = useCapabilityMemberAccess(enabled && statuses !== undefined, gatewayInstalled);
  const rows = statuses ? capabilityRows(statuses, access) : [];
  const workbotInTeams = workbotSettingsInTeams(orgContext);
  const mismatch = installedButOffMessage(rows);

  const columns: DenTableColumn<CapabilityRow>[] = [
    { key: "capability", header: "Capability", width: "220px", render: (row) => <span className="whitespace-nowrap font-medium text-[var(--dls-text-primary)]">{row.label}</span> },
    { key: "infrastructure", header: "Infrastructure", width: "190px", render: (row) => <ExplainedState label={row.infrastructure} detail={row.reason} testId={`capability-infrastructure-${row.id}`} /> },
    { key: "access", header: "Member access", render: (row) => <AccessCell row={row} /> },
    {
      key: "action", header: "", align: "right", width: "150px",
      render: (row) => canManage(row.access)
        ? <span className="inline-flex h-[19px] items-center"><DenButton href={accessRoute(row.id, orgSlug, workbotInTeams, slackConnectorId)} variant="ghost" size="inline" aria-label={`Manage ${row.label} access`} data-testid={`capability-manage-${row.id}`}>Manage access</DenButton></span>
        : null,
    },
  ];

  return (
    <ItemPage testId="capabilities-screen" wide>
      <DenPageHeader title="Capabilities" size="compact" />
      {orgBusy || !orgContext ? (
        <div className="grid gap-2" role="status" aria-label="Loading capabilities">
          {[0, 1, 2, 3, 4].map((row) => <DenSkeleton key={row} className="h-11" />)}
        </div>
      ) : !enabled ? (
        <DenNotice tone="neutral" icon={LockKeyhole} message="The capabilities view isn't enabled in this workspace." />
      ) : !statuses ? (
        <DenNotice tone="info" message="This server doesn't report what is installed yet. Update OpenWork to see its capabilities." />
      ) : (
        <>
          {mismatch ? <DenNotice tone="warning" message={<span data-testid="capabilities-installed-but-off">{mismatch}</span>} /> : null}
          <div data-testid="capabilities-table">
            <DenTable columns={columns} rows={rows} getRowKey={(row) => row.id} density="compact" />
          </div>
        </>
      )}
    </ItemPage>
  );
}
