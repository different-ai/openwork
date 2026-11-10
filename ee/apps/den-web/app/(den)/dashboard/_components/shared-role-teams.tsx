"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useRef, useState } from "react";
import { Users } from "lucide-react";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { roleSetTeams } from "../../_lib/role-catalog";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { AccessRow, AddPicker, IconTile, RemoveButton } from "./access-rows";
import { useDenToast } from "./den-toast";
import { ItemPanel } from "./item-list";
import { usePermissionSets, useRenameRole, useSetTeamRole, type PermissionSetDetail } from "./permissions-data";
import type { PermissionsAccess } from "./permissions-ui";

type ReadyAccess = Extract<PermissionsAccess, { state: "ready" }>;

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * sharedRoles: the teams a custom role is on. Removing it from a team (after
 * a confirm) leaves the others; Add team gives it to more teams, replacing
 * each team's current custom role.
 */
export function SharedRoleTeams({ ready, set }: { ready: ReadyAccess; set: PermissionSetDetail }) {
  const toast = useDenToast();
  const { orgContext } = useOrgDashboard();
  const setTeamRole = useSetTeamRole(ready.orgId);
  const setsQuery = usePermissionSets(ready.orgId, true);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canManage = ready.access.canManagePermissions;
  const teams = orgContext?.teams ?? [];
  const onRole = new Set(set.teams.map((team) => team.id));
  const roleByTeam = new Map<string, string>();
  for (const other of setsQuery.data ?? []) {
    if (other.kind !== "team" || other.id === set.id) continue;
    for (const team of roleSetTeams(other)) roleByTeam.set(team.id, other.name);
  }
  const addable = teams
    .filter((team) => !onRole.has(team.id))
    .map((team) => ({
      id: team.id,
      name: team.name,
      detail: team.grantsOrganizationAdmin ? "Admin team" : roleByTeam.has(team.id) ? `Now ${roleByTeam.get(team.id)}` : "Now Member",
    }));

  async function add(ids: string[]) {
    setError(null);
    try {
      for (const teamId of ids) await setTeamRole.mutateAsync({ teamId, permissionSetId: set.id });
      const names = ids.map((id) => teams.find((team) => team.id === id)?.name ?? "a team");
      toast({ title: `${set.name} given to ${names.join(", ")}` });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't give the role.");
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="role-teams">
      <ItemPanel>
        {set.teams.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-gray-500" data-testid="role-teams-empty">No team has this role.</p>
        ) : set.teams.map((team) => {
          const name = team.name ?? "A deleted team";
          const memberCount = teams.find((entry) => entry.id === team.id)?.memberIds.length ?? 0;
          return (
            <AccessRow
              key={team.id}
              lead={<IconTile icon={Users} />}
              title={name}
              description={plural(memberCount, "member")}
              trailing={canManage ? <RemoveButton label={`Remove ${set.name} from ${name}`} onClick={() => setRemoving({ id: team.id, name })} /> : undefined}
              testId="role-team-row"
            />
          );
        })}
        <div className="flex px-5 py-3">
          <AddPicker kind="team" options={addable} disabled={!canManage || setTeamRole.isPending} onAdd={(ids) => void add(ids)} />
        </div>
      </ItemPanel>
      {error ? <DenNotice tone="error" message={error} /> : null}
      <RemoveRoleFromTeam
        set={set}
        team={removing}
        onClose={() => setRemoving(null)}
        onRemove={async (team) => {
          await setTeamRole.mutateAsync({ teamId: team.id, permissionSetId: null });
          toast({
            title: `Removed ${set.name} from ${team.name}`,
            action: { label: "Undo", onClick: () => { void setTeamRole.mutateAsync({ teamId: team.id, permissionSetId: set.id }); } },
          });
        }}
      />
    </div>
  );
}

/** Confirm before a team loses the role (DESIGN.md P8: it is a loss). */
function RemoveRoleFromTeam({ set, team, onClose, onRemove }: {
  set: PermissionSetDetail;
  team: { id: string; name: string } | null;
  onClose: () => void;
  onRemove: (team: { id: string; name: string }) => Promise<void>;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = set.teams.filter((entry) => entry.id !== team?.id).map((entry) => entry.name ?? "A deleted team");

  async function confirm() {
    if (!team) return;
    setBusy(true);
    setError(null);
    try {
      await onRemove(team);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't remove the role.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog.Root open={team !== null} onOpenChange={(next) => { if (!next && !busy) { setError(null); onClose(); } }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/45" />
        <AlertDialog.Popup initialFocus={cancelRef} className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[16px] border border-gray-200 bg-white p-5 outline-none" data-testid="role-team-remove-dialog">
          <AlertDialog.Title className="text-[15px] font-medium text-gray-950">Remove {set.name} from {team?.name}?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-[13px] leading-5 text-gray-600">
            People in {team?.name} lose these permissions now.{others.length > 0 ? ` ${others.join(", ")} keep${others.length === 1 ? "s" : ""} the role.` : ""}
          </AlertDialog.Description>
          {error ? <DenNotice tone="error" className="mt-3" message={error} /> : null}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close ref={cancelRef} disabled={busy} className={buttonVariants({ variant: "secondary" })}>Cancel</AlertDialog.Close>
            <DenButton variant="destructive" loading={busy} onClick={() => void confirm()} data-testid="role-team-remove-confirm">Remove</DenButton>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** sharedRoles: the role's name, renamed in place. */
export function RoleNameField({ ready, set }: { ready: ReadyAccess; set: PermissionSetDetail }) {
  const toast = useDenToast();
  const rename = useRenameRole(ready.orgId, set.id);
  const [name, setName] = useState(set.name);
  const trimmed = name.trim();
  const changed = trimmed.length > 0 && trimmed !== set.name;
  const canManage = ready.access.canManagePermissions;

  async function save() {
    if (!changed) return;
    try {
      await rename.mutateAsync(trimmed);
      toast({ title: `Renamed to ${trimmed}` });
    } catch {
      return;
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="role-name" className="text-[13px] font-medium text-gray-700">Role name</label>
      <div className="flex items-center gap-2">
        <DenInput
          id="role-name"
          className="max-w-sm"
          value={name}
          maxLength={120}
          disabled={!canManage}
          onChange={(event) => { rename.reset(); setName(event.target.value); }}
          onKeyDown={(event) => { if (event.key === "Enter") void save(); }}
          data-testid="role-name"
        />
        {changed ? <DenButton size="sm" loading={rename.isPending} onClick={() => void save()} data-testid="role-name-save">Rename</DenButton> : null}
      </div>
      {rename.error ? <DenNotice tone="error" message={rename.error.message} /> : null}
    </div>
  );
}
