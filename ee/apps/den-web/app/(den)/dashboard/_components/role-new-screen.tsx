"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PERMISSION_KEYS, type PermissionKey } from "@openwork/types/den/permissions";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { getMembersRoute, getPermissionSetRoute } from "../../_lib/den-org";
import { useDenToast } from "./den-toast";
import { TeamsField } from "./access-rows";
import { LinkButton } from "./item-list";
import { useCreateSharedRole, usePermissionSets, type PermissionStatus } from "./permissions-data";
import {
  PermissionEditor,
  PermissionsAccessState,
  PermissionsPage,
  usePermissionsAccess,
  type PermissionEditorRow,
  type PermissionsAccess,
} from "./permissions-ui";

import { useOrgDashboard } from "../_providers/org-dashboard-provider";

type ReadyAccess = Extract<PermissionsAccess, { state: "ready" }>;

/** Create a named role and give it to teams. */
export function RoleNewScreen() {
  const permissions = usePermissionsAccess();

  if (permissions.state !== "ready") {
    return <PermissionsPage title="Create role" testId="role-new"><PermissionsAccessState access={permissions} /></PermissionsPage>;
  }
  return <SharedRoleNewContent ready={permissions} />;
}

/**
 * sharedRoles: a role is created by name, given to any teams now (each team's
 * custom role is replaced), and starts with no permissions: the person turns
 * on what it adds.
 */
function SharedRoleNewContent({ ready }: { ready: ReadyAccess }) {
  const { orgContext } = useOrgDashboard();
  const router = useRouter();
  const toast = useDenToast();
  const create = useCreateSharedRole(ready.orgId);
  const setsQuery = usePermissionSets(ready.orgId, true);
  const [name, setName] = useState("");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [allowed, setAllowed] = useState<ReadonlySet<PermissionKey>>(new Set());
  const back = { href: `${getMembersRoute(ready.orgSlug)}?tab=roles`, label: "Roles" };
  const trimmed = name.trim();

  const roleByTeam = new Map<string, string>();
  for (const set of setsQuery.data ?? []) {
    if (set.kind !== "team") continue;
    for (const team of set.teams.length > 0 ? set.teams : set.team ? [set.team] : []) roleByTeam.set(team.id, set.name);
  }
  const teams = (orgContext?.teams ?? []).map((team) => ({
    id: team.id,
    name: team.name,
    detail: `${team.memberIds.length} ${team.memberIds.length === 1 ? "member" : "members"}, now ${team.grantsOrganizationAdmin ? "Admin" : roleByTeam.get(team.id) ?? "Member"}`,
  }));
  const chosenNames = teamIds.flatMap((id) => teams.find((team) => team.id === id)?.name ?? []);

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
    if (!trimmed) return;
    try {
      const set = await create.mutateAsync({ name: trimmed, teamIds, permissions: [...allowed].map((key) => ({ key, status: "allow" })) });
      toast({ title: `${trimmed} created` });
      router.replace(getPermissionSetRoute(ready.orgSlug, set.id));
    } catch {
      return;
    }
  }

  return (
    <PermissionsPage title="Create role" back={back} testId="role-new">
      <label className="flex max-w-sm flex-col gap-1.5">
        <span className="text-[13px] font-medium text-gray-700">Role name</span>
        <DenInput value={name} onChange={(event) => { create.reset(); setName(event.target.value); }} placeholder="Skill publisher" maxLength={120} data-testid="role-new-name" />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-gray-700">Teams</span>
        <TeamsField teams={teams} chosenIds={teamIds} onChange={(ids) => { create.reset(); setTeamIds(ids); }} rowTestId="role-new-team" />
      </div>

      {create.error ? <DenNotice tone="error" message={create.error.message} /> : null}

      <PermissionEditor rows={rows} onToggle={toggle} />

      <DenStickyActionBar
        testId="role-new-save-bar"
        summary={trimmed ? (
          <span className="flex flex-col">
            <span className="font-medium text-gray-900">{`${allowed.size} ${allowed.size === 1 ? "permission" : "permissions"} selected`}</span>
            <span>{chosenNames.length > 0 ? `Given to ${chosenNames.join(", ")}` : "No team yet"}</span>
          </span>
        ) : <span>Name the role to save</span>}
      >
        <LinkButton variant="secondary" href={back.href}>Cancel</LinkButton>
        <DenButton disabled={!trimmed} loading={create.isPending} onClick={() => void submit()} data-testid="role-new-create">Create role</DenButton>
      </DenStickyActionBar>
    </PermissionsPage>
  );
}
