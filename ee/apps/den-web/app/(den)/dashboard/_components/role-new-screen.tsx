"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PERMISSION_KEYS, type PermissionKey } from "@openwork/types/den/permissions";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSegmented } from "../../_components/ui/segmented";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { getMembersRoute, getPermissionSetRoute, orgFeatureEnabled } from "../../_lib/den-org";
import { markFeatureUsed } from "../../_lib/feature-usage";
import {
  BUILT_IN_ROLES,
  READY_MADE_ROLES,
  ROLE_STARTS,
  isReadyMadeRoleId,
  isRoleStart,
  roleSetTeams,
  roleStartKeys,
  roleStartLabel,
  roleStartMissingLabels,
  type RoleStart,
} from "../../_lib/role-catalog";
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

/** Create a named role and give it to teams. `requestedStart` is the address's `?start=`, e.g. "billing". */
export function RoleNewScreen({ requestedStart = null }: { requestedStart?: string | null }) {
  const permissions = usePermissionsAccess();

  if (permissions.state !== "ready") {
    return <PermissionsPage title="Create role" testId="role-new"><PermissionsAccessState access={permissions} /></PermissionsPage>;
  }
  return <SharedRoleNewContent ready={permissions} requestedStart={requestedStart && isRoleStart(requestedStart) ? requestedStart : "member"} />;
}

/**
 * sharedRoles: a role is created by name, given to any teams now (each team's
 * custom role is replaced), and starts with no permissions: the person turns
 * on what it adds.
 *
 * readyMadeRoles: the person can choose where the role starts (Member, Admin,
 * a ready-made role, or everything), limited to what they hold themselves.
 * A ready-made role also fills in its name.
 */
function SharedRoleNewContent({ ready, requestedStart }: { ready: ReadyAccess; requestedStart: RoleStart }) {
  const { orgContext } = useOrgDashboard();
  const router = useRouter();
  const toast = useDenToast();
  const create = useCreateSharedRole(ready.orgId);
  const setsQuery = usePermissionSets(ready.orgId, true);
  const startChoice = orgFeatureEnabled(orgContext, "readyMadeRoles");
  // Off: the role starts as Member, with nothing turned on, as before.
  const [chosenStart, setStart] = useState<RoleStart>(requestedStart);
  const start: RoleStart = startChoice ? chosenStart : "member";
  const [name, setName] = useState(startChoice && isReadyMadeRoleId(requestedStart) ? READY_MADE_ROLES[requestedStart].label : "");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  // Switches the person changed by hand. Choosing another starting point keeps them.
  const [overrides, setOverrides] = useState<ReadonlyMap<PermissionKey, PermissionStatus>>(new Map());
  const base = new Set(roleStartKeys(start, ready.held));
  const allowed = new Set(PERMISSION_KEYS.filter((key) => (overrides.get(key) ?? (base.has(key) ? "allow" : "deny")) === "allow"));
  const missing = roleStartMissingLabels(start, ready.held);
  const back = { href: `${getMembersRoute(ready.orgSlug)}?tab=roles`, label: "Roles" };
  const trimmed = name.trim();

  const roleByTeam = new Map<string, string>();
  for (const set of setsQuery.data ?? []) {
    if (set.kind !== "team") continue;
    for (const team of roleSetTeams(set)) roleByTeam.set(team.id, set.name);
  }
  const teams = (orgContext?.teams ?? []).map((team) => ({
    id: team.id,
    name: team.name,
    detail: `${team.memberIds.length} ${team.memberIds.length === 1 ? "member" : "members"}, now ${team.grantsOrganizationAdmin ? BUILT_IN_ROLES.admin.label : roleByTeam.get(team.id) ?? BUILT_IN_ROLES.member.label}`,
  }));
  const chosenNames = teamIds.flatMap((id) => teams.find((team) => team.id === id)?.name ?? []);

  const rows: PermissionEditorRow[] = PERMISSION_KEYS.map((key) => {
    const status: PermissionStatus = allowed.has(key) ? "allow" : "deny";
    return { key, status, draft: status, lockedReason: ready.held.has(key) ? null : "You don't have this permission" };
  });

  function toggle(key: PermissionKey, next: PermissionStatus) {
    create.reset();
    setOverrides((current) => new Map(current).set(key, next));
  }

  function chooseStart(next: RoleStart) {
    create.reset();
    setStart(next);
    // A ready-made role brings its name, unless the person already typed their own.
    const suggested = isReadyMadeRoleId(start) ? READY_MADE_ROLES[start].label : "";
    if (trimmed === "" || trimmed === suggested) setName(isReadyMadeRoleId(next) ? READY_MADE_ROLES[next].label : "");
  }

  async function submit() {
    if (!trimmed) return;
    try {
      const set = await create.mutateAsync({ name: trimmed, teamIds, permissions: [...allowed].map((key) => ({ key, status: "allow" })) });
      if (startChoice && isReadyMadeRoleId(start)) markFeatureUsed("readyMadeRoles");
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

      {startChoice ? (
        <div className="flex flex-col items-start gap-1.5" data-testid="role-new-start">
          <span className="text-[13px] font-medium text-gray-700">Start from</span>
          <DenSegmented
            aria-label="Start from"
            value={start}
            onChange={chooseStart}
            options={ROLE_STARTS.map((option) => ({ value: option, label: roleStartLabel(option) }))}
            optionTestId={(option) => `role-new-start-${option}`}
          />
          {/* Blocked, not an error: say what is left out and why (C5). */}
          {missing.length > 0 ? (
            <p className="text-[13px] text-gray-500" data-testid="role-new-start-missing">
              {`${roleStartLabel(start)} also has ${missing.join(", ")}. You don't have ${missing.length === 1 ? "that permission" : "those permissions"}, so this role starts without ${missing.length === 1 ? "it" : "them"}.`}
            </p>
          ) : null}
        </div>
      ) : null}

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
