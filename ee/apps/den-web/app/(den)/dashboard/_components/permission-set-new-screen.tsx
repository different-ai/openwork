"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PERMISSION_KEYS, type PermissionKey } from "@openwork/types/den/permissions";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenSelect } from "../../_components/ui/select";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { getMembersRoute, getPermissionSetRoute, getPermissionsRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useDenToast } from "./den-toast";
import { LinkButton } from "./item-list";
import { PermissionsRequestError, useCreateTeamPermissions, usePermissionSets, type PermissionStatus } from "./permissions-data";
import {
  PermissionEditor,
  PermissionRowsSkeleton,
  PermissionsAccessState,
  PermissionsPage,
  usePermissionsAccess,
  type PermissionEditorRow,
  type PermissionsAccess,
} from "./permissions-ui";

type ReadyAccess = Extract<PermissionsAccess, { state: "ready" }>;

export function NewTeamPermissionsScreen() {
  const permissions = usePermissionsAccess();
  if (permissions.state !== "ready") {
    return <PermissionsPage title="New team permissions" testId="new-team-permissions"><PermissionsAccessState access={permissions} /></PermissionsPage>;
  }
  return <NewTeamPermissionsContent ready={permissions} />;
}

function NewTeamPermissionsContent({ ready }: { ready: ReadyAccess }) {
  const router = useRouter();
  const toast = useDenToast();
  const { orgContext } = useOrgDashboard();
  const setsQuery = usePermissionSets(ready.orgId);
  const create = useCreateTeamPermissions(ready.orgId);
  const [teamId, setTeamId] = useState("");
  const [allowed, setAllowed] = useState<ReadonlySet<PermissionKey>>(new Set());
  const back = { href: getPermissionsRoute(ready.orgSlug), label: "Permissions" };

  const teamsWithPermissions = new Set((setsQuery.data ?? []).flatMap((set) => set.kind === "team" && set.team ? [set.team.id] : []));
  const teams = (orgContext?.teams ?? []).filter((team) => !teamsWithPermissions.has(team.id)).sort((a, b) => a.name.localeCompare(b.name));
  const team = teams.find((entry) => entry.id === teamId) ?? null;

  const rows: PermissionEditorRow[] = PERMISSION_KEYS.map((key) => {
    const status: PermissionStatus = allowed.has(key) ? "allow" : "deny";
    return { key, status, draft: status, lockedReason: ready.held.has(key) ? null : "You don't have this permission" };
  });

  function toggle(key: PermissionKey, next: PermissionStatus) {
    create.reset();
    setAllowed((current) => {
      const copy = new Set(current);
      if (next === "allow") copy.add(key);
      else copy.delete(key);
      return copy;
    });
  }

  async function submit() {
    if (!team) return;
    try {
      const created = await create.mutateAsync({ teamId: team.id, permissions: [...allowed].map((key) => ({ key, status: "allow" })) });
      toast({ title: `Created ${created.name}` });
      router.replace(getPermissionSetRoute(ready.orgSlug, created.id));
    } catch {
      return;
    }
  }

  const conflict = create.error instanceof PermissionsRequestError && create.error.code === "team_permission_set_exists" ? create.error : null;

  return (
    <PermissionsPage title="New team permissions" back={back} testId="new-team-permissions">
      {setsQuery.isPending ? <PermissionRowsSkeleton rows={3} label="Loading teams" /> : setsQuery.isError ? (
        <div className="flex flex-col items-start gap-2">
          <DenNotice tone="error" className="w-full" message={setsQuery.error instanceof Error ? setsQuery.error.message : "Couldn't load teams."} />
          <DenButton variant="secondary" size="sm" disabled={setsQuery.isFetching} onClick={() => void setsQuery.refetch()}>Try again</DenButton>
        </div>
      ) : teams.length === 0 ? (
        <div className="flex flex-col items-start gap-2 py-2" data-testid="new-team-permissions-empty">
          <p className="text-[13px] text-gray-600">{(orgContext?.teams.length ?? 0) === 0 ? "No teams yet. Create a team first, then give it permissions." : "Every team already has permissions."}</p>
          {(orgContext?.teams.length ?? 0) === 0 ? <LinkButton href={getMembersRoute(ready.orgSlug)} variant="secondary" size="sm">Go to Members</LinkButton> : null}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <div className="flex max-w-sm flex-col gap-1.5">
              <span id="new-team-permissions-team-label" className="text-[13px] font-medium text-gray-700">Team</span>
              <DenSelect aria-labelledby="new-team-permissions-team-label" value={teamId} onChange={(event) => { create.reset(); setTeamId(event.target.value); }}>
                <option value="">Choose a team</option>
                {teams.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
              </DenSelect>
            </div>
            {team ? (
              <p className="text-[12px] text-gray-500" data-testid="new-team-permissions-name">
                Saved as “{team.name} Permissions”. The name stays if the team is renamed.
              </p>
            ) : null}
          </div>
          {conflict ? (
            <DenNotice
              tone="neutral"
              message={<>This team already has permissions. {conflict.permissionSetId ? <Link className="font-medium underline underline-offset-2" href={getPermissionSetRoute(ready.orgSlug, conflict.permissionSetId)}>Open them</Link> : null}</>}
            />
          ) : create.error ? <DenNotice tone="error" message={create.error.message} /> : null}
          <PermissionEditor rows={rows} onToggle={toggle} />
          <DenStickyActionBar testId="new-team-permissions-save-bar" summary={<span>{team ? `${allowed.size} allowed for ${team.name}` : "Choose a team to save"}</span>}>
            <LinkButton variant="secondary" href={getPermissionsRoute(ready.orgSlug)}>Cancel</LinkButton>
            <DenButton disabled={!team} loading={create.isPending} onClick={() => void submit()}>Create team permissions</DenButton>
          </DenStickyActionBar>
        </>
      )}
    </PermissionsPage>
  );
}
