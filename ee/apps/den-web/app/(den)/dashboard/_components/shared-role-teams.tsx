"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useEffect, useRef, useState } from "react";
import { Users } from "lucide-react";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { AccessRow, AddPicker, IconTile, RemoveButton } from "./access-rows";
import { useDenToast } from "./den-toast";
import { ItemPanel, LinkButton } from "./item-list";
import { PermissionsRequestError, usePermissionSets, useRenameRole, useSetTeamRole, type PermissionSetDetail } from "./permissions-data";
import { permissionSetTeams } from "./team-roles";
import { canRetryRoleAssignment, reconcileRoleAssignment, roleWriteFailureStatus, type RoleAssignmentOutcome } from "./role-assignment-state";
import { getTeamRoute, permissionLockReason } from "../../_lib/den-org";
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
  const [assigning, setAssigning] = useState(false);
  const [outcomes, setOutcomes] = useState<RoleAssignmentOutcome[]>([]);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const canManage = ready.access.canManagePermissions;
  const listedRole = setsQuery.data?.find((role) => role.id === set.id);
  const unavailable = setsQuery.isSuccess && !listedRole;
  // Reconciliation reads this inventory. Its verified associations must also
  // drive the visible rows, rather than an older detail projection.
  const displayedTeams = setsQuery.isSuccess && listedRole ? permissionSetTeams(listedRole) : set.teams;
  const teams = orgContext?.teams ?? [];
  const roleByTeam = new Map<string, { id: string; name: string }>();
  for (const role of setsQuery.data ?? []) {
    if (role.kind !== "team") continue;
    for (const team of permissionSetTeams(role)) roleByTeam.set(team.id, { id: role.id, name: role.name });
  }
  const addable = teams.filter((team) => roleByTeam.get(team.id)?.id !== set.id).map((team) => ({
    id: team.id,
    name: team.name,
    detail: `${roleByTeam.has(team.id) ? `Replaces ${roleByTeam.get(team.id)?.name}` : "Adds this custom role"}${team.grantsOrganizationAdmin ? "; keeps organization Admin access" : ""}`,
  }));

  async function reconcile(entries: RoleAssignmentOutcome[], ids: readonly string[]) {
    const result = await setsQuery.refetch({ throwOnError: true });
    if (!result.isSuccess || !result.data) throw new Error("Couldn't verify current roles. No retry was sent.");
    if (!result.data.some((role) => role.id === set.id && role.kind === "team")) throw new Error("This role is no longer in the active role list. No retry was sent.");
    const currentRoles = new Map<string, { id: string; name: string }>();
    for (const role of result.data) {
      if (role.kind !== "team") continue;
      for (const team of permissionSetTeams(role)) currentRoles.set(team.id, { id: role.id, name: role.name });
    }
    return entries.map((entry) => {
      if (!ids.includes(entry.id)) return entry;
      const current = currentRoles.get(entry.id);
      return reconcileRoleAssignment(entry, current?.id ?? null, current?.name ?? "No custom role listed", set.id);
    });
  }

  async function checkCurrentRoles() {
    if (assigning || checking) return;
    setChecking(true);
    setCheckError(null);
    try {
      const checked = await reconcile(outcomes, outcomes.filter((entry) => entry.status === "unconfirmed" || entry.status === "review").map((entry) => entry.id));
      if (active.current) setOutcomes(checked);
    } catch (cause) {
      if (active.current) setCheckError(cause instanceof Error ? cause.message : "Couldn't verify current roles. No retry was sent.");
    } finally { if (active.current) setChecking(false); }
  }

  async function add(ids: string[], retry = false) {
    if (assigning || checking) throw new Error("The submitted teams are still being checked.");
    if (!canManage || unavailable || !setsQuery.isSuccess || !setsQuery.data) throw new Error("Couldn't verify permission to assign this role. Your selections are kept; try again after access is verified.");
    if (ids.some((id) => outcomes.some((entry) => entry.id === id && (entry.status === "unconfirmed" || entry.status === "review")))) throw new Error("These teams need a current-role check or review. No assignment was replayed.");
    const submitted: RoleAssignmentOutcome[] = ids.map((id) => {
      const previous = outcomes.find((entry) => entry.id === id);
      return { id, name: teams.find((team) => team.id === id)?.name ?? "A team no longer available", beforeRoleId: previous?.status === "failed" ? previous.beforeRoleId : roleByTeam.get(id)?.id ?? null, status: "pending" };
    });
    let next = [...outcomes.filter((entry) => !ids.includes(entry.id)), ...submitted];
    setAssigning(true);
    setCheckError(null);
    setOutcomes(next);
    let sent = false;
    try {
      // A fresh read checks replacement prerequisites before any write or retry.
      // A changed role needs a new review, never an automatic overwrite.
      next = await reconcile(next, ids);
      if (!active.current) return;
      setOutcomes(next);
      if (next.some((entry) => ids.includes(entry.id) && entry.status === "review")) throw new Error("Current roles changed. Review the affected team before assigning again. No retry was sent.");
      for (const entry of submitted) {
        if (!active.current) return;
        if (next.find((result) => result.id === entry.id)?.status === "assigned") continue;
        try {
          sent = true;
          await setTeamRole.mutateAsync({ teamId: entry.id, permissionSetId: set.id });
          next = next.map((result) => result.id === entry.id ? { ...result, status: "assigned", error: undefined } : result);
        } catch (cause) {
          const status = roleWriteFailureStatus(cause instanceof PermissionsRequestError ? cause.status : undefined);
          next = next.map((result) => result.id === entry.id ? { ...result, status, error: cause instanceof Error ? cause.message : "Couldn't confirm the role." } : result);
        }
        if (active.current) setOutcomes(next);
      }
      const unknownIds = next.filter((entry) => ids.includes(entry.id) && entry.status === "unconfirmed").map((entry) => entry.id);
      if (unknownIds.length) {
        try { next = await reconcile(next, unknownIds); }
        catch (cause) { if (active.current) setCheckError(cause instanceof Error ? cause.message : "Couldn't verify current roles. No retry was sent."); }
        if (active.current) setOutcomes(next);
      }
      if (!active.current) return;
      const unresolved = next.filter((entry) => ids.includes(entry.id) && entry.status !== "assigned");
      if (unresolved.length) throw new Error(`${unresolved.length} ${unresolved.length === 1 ? "team needs" : "teams need"} attention. Review the team results; only rejected assignments can be retried.`);
      toast({ title: `${retry ? "Confirmed" : "Assigned"} ${set.name} for ${submitted.length} ${submitted.length === 1 ? "team" : "teams"}` });
    } catch (cause) {
      if (!sent) {
        next = next.map((entry) => ids.includes(entry.id) && entry.status === "pending" ? { ...entry, status: "failed", error: "No assignment was sent. Verify current roles before trying again." } : entry);
        if (active.current) setOutcomes(next);
      }
      throw cause;
    } finally { if (active.current) setAssigning(false); }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="role-teams">
      {!canManage ? <DenNotice tone="neutral" message={permissionLockReason("permissions.manage")} /> : null}
      <ItemPanel>
        {unavailable ? <p className="px-5 py-4 text-[13px] text-gray-500">This role is not in the verified active role list. Assignment is blocked.</p> : displayedTeams.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-gray-500" data-testid="role-teams-empty">No team has this role.</p>
        ) : displayedTeams.map((team) => {
          const name = team.name ?? "A deleted team";
          const memberCount = teams.find((entry) => entry.id === team.id)?.memberIds.length;
          return (
            <AccessRow
              key={team.id}
              lead={<IconTile icon={Users} />}
              title={name}
              description={memberCount === undefined ? "Member count not verified" : plural(memberCount, "member")}
              trailing={canManage ? <RemoveButton label={`Remove ${set.name} from ${name}`} onClick={() => setRemoving({ id: team.id, name })} /> : undefined}
              testId="role-team-row"
            />
          );
        })}
        <div className="flex px-5 py-3">
          <AddPicker kind="team" options={addable} disabled={!canManage || unavailable || assigning || checking || !setsQuery.isSuccess} onAdd={add} triggerLabel="Assign role" actionLabel="Assign role" showConsequences />
        </div>
      </ItemPanel>
      {setsQuery.isError ? <DenNotice tone="error" message="Couldn't verify the teams' current roles. Assignment is blocked until they are verified." action={<DenButton size="sm" variant="secondary" onClick={() => void setsQuery.refetch()}>Try again</DenButton>} /> : null}
      {outcomes.length > 0 ? <div className="grid gap-2" aria-label="Role assignment results">
        <ul className="divide-y divide-gray-100 text-[13px]" aria-live="polite">{outcomes.map((entry) => <li key={entry.id} className="flex min-h-11 flex-wrap items-start justify-between gap-2 py-2" data-testid="role-assignment-result" data-status={entry.status}>
          <span className="min-w-0 break-words font-medium">{entry.name}</span>
          <span className="flex min-w-0 flex-col gap-1 break-words text-gray-500">
            <span className={entry.status === "failed" ? "text-red-700" : undefined}>{entry.status === "assigned" ? "Role assigned" : entry.status === "pending" ? "Not confirmed yet" : entry.status === "failed" ? `Not assigned: ${entry.error}` : entry.status === "review" ? "Current role changed; review before assigning again" : `Unconfirmed: ${entry.error ?? "The request may still finish."}`}</span>
            {entry.currentRoleName && entry.status !== "assigned" ? <span>Current custom role: {entry.currentRoleName}</span> : null}
            {entry.status === "review" ? <LinkButton size="sm" variant="secondary" href={getTeamRoute(ready.orgSlug, entry.id)}>Review team</LinkButton> : null}
          </span>
        </li>)}</ul>
        <div className="flex flex-wrap gap-2">
          {outcomes.some(canRetryRoleAssignment) ? <DenButton size="sm" variant="secondary" disabled={!canManage || unavailable || assigning || checking || !setsQuery.isSuccess} onClick={() => void add(outcomes.filter(canRetryRoleAssignment).map((entry) => entry.id), true).catch((cause) => setCheckError(cause instanceof Error ? cause.message : "Couldn't retry rejected assignments."))}>Retry failed teams</DenButton> : null}
          {outcomes.some((entry) => entry.status === "unconfirmed" || entry.status === "review") ? <DenButton size="sm" variant="secondary" loading={checking} disabled={assigning} onClick={() => void checkCurrentRoles()}>Check current roles</DenButton> : null}
        </div>
        {checkError ? <DenNotice tone="error" message={checkError} /> : null}
      </div> : null}
      <RemoveRoleFromTeam
        set={set}
        team={removing}
        onClose={() => setRemoving(null)}
        onRemove={async (team) => {
          if (!canManage || unavailable) throw new Error("This role's assignment must be verified before it can be removed.");
          const current = await setsQuery.refetch({ throwOnError: true });
          if (!active.current) return;
          const role = current.data?.find((entry) => entry.id === set.id);
          if (!role || !permissionSetTeams(role).some((entry) => entry.id === team.id)) throw new Error("This team no longer has this role. Review its current access; nothing was removed.");
          await setTeamRole.mutateAsync({ teamId: team.id, permissionSetId: null });
          if (!active.current) return;
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
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [nameBase, setNameBase] = useState(set.name);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const name = nameDraft ?? set.name;
  const trimmed = name.trim();
  const changed = trimmed.length > 0 && trimmed !== set.name;
  const conflict = nameDraft !== null && set.name !== nameBase && trimmed !== set.name;
  const canManage = ready.access.canManagePermissions;

  async function save() {
    if (!changed || conflict || !canManage) return;
    try {
      await rename.mutateAsync(trimmed);
      if (!active.current) return;
      setNameDraft(null);
      toast({ title: `Renamed to ${trimmed}` });
    } catch {
      return;
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="role-name" className="text-[13px] font-medium text-gray-700">Role name</label>
      <div className="flex flex-wrap items-center gap-2">
        <DenInput
          id="role-name"
          className="w-full min-w-0 sm:max-w-sm"
          value={name}
          maxLength={120}
          disabled={!canManage || rename.isPending}
          onChange={(event) => { if (nameDraft === null) setNameBase(set.name); rename.reset(); setNameDraft(event.target.value === set.name ? null : event.target.value); }}
          onKeyDown={(event) => { if (event.key === "Enter") void save(); }}
          data-testid="role-name"
        />
        {nameDraft !== null ? <DenButton size="sm" variant="secondary" disabled={rename.isPending} onClick={() => { setNameDraft(null); rename.reset(); }}>Discard name edit</DenButton> : null}
        {changed ? <DenButton size="sm" loading={rename.isPending} disabled={conflict || !canManage} onClick={() => void save()} data-testid="role-name-save">Rename</DenButton> : null}
      </div>
      {conflict ? <DenNotice tone="warning" message={`The saved role name changed to ${set.name}. Your draft is kept.`} action={<DenButton size="sm" variant="secondary" onClick={() => setNameBase(set.name)}>Keep my name edit</DenButton>} /> : null}
      {rename.error ? <DenNotice tone="error" message={rename.error.message} /> : null}
    </div>
  );
}
