"use client";

import { LockKeyhole, Users } from "lucide-react";
import { AccessRow, AddPicker, Avatar, IconTile, RemoveButton, type PickerOption } from "./access-rows";
import { ItemPanel, ItemSection } from "./item-list";

export type RoleHolderRow = {
  id: string;
  name: string;
  detail: string;
  /** Why this row can't be removed here, or null when it can. */
  lockReason?: string | null;
};

/**
 * Who a role is given to: people and teams as rows with Remove, then Add
 * person and Add team. The same block on a role's page (changes apply at
 * once) and on Create role (a draft), so a role is given the same way in both.
 */
export function RoleHolders({ title, people, teams, addablePeople, addableTeams, onAddPeople, onAddTeams, onRemovePerson, onRemoveTeam, peopleLockReason, teamsLockReason, empty = "Nobody yet.", testId }: {
  title: string;
  people: readonly RoleHolderRow[];
  teams: readonly RoleHolderRow[];
  addablePeople: PickerOption[];
  addableTeams: PickerOption[];
  onAddPeople: (ids: string[]) => void;
  onAddTeams: (ids: string[]) => void;
  onRemovePerson: (id: string) => void;
  onRemoveTeam: (id: string) => void;
  /** Why the signed-in person can't give this role to people, or null when they can. */
  peopleLockReason?: string | null;
  /** Why the signed-in person can't give this role to teams, or null when they can. */
  teamsLockReason?: string | null;
  empty?: string;
  testId?: string;
}) {
  // One line says why: both pickers locked for the same reason read once.
  const lockReasons = peopleLockReason && peopleLockReason === teamsLockReason
    ? [peopleLockReason]
    : [peopleLockReason ? `Add person: ${peopleLockReason}` : null, teamsLockReason ? `Add team: ${teamsLockReason}` : null].flatMap((reason) => reason ?? []);
  const locked = (reason: string) => (
    <span className="inline-flex shrink-0 items-center text-gray-500" title={reason}>
      <LockKeyhole className="h-3.5 w-3.5" aria-hidden />
      <span className="sr-only">{reason}</span>
    </span>
  );
  return (
    <ItemSection title={title} testId={testId}>
      <ItemPanel>
        {people.length === 0 && teams.length === 0 ? <p className="px-5 py-4 text-[13px] text-gray-500" data-testid="role-holders-empty">{empty}</p> : null}
        {people.map((person) => (
          <AccessRow
            key={person.id}
            lead={<Avatar name={person.name} />}
            title={person.name}
            description={person.detail}
            trailing={person.lockReason ? locked(person.lockReason) : <RemoveButton label={`Remove ${person.name}`} onClick={() => onRemovePerson(person.id)} />}
            testId="role-holder-person"
          />
        ))}
        {teams.map((team) => (
          <AccessRow
            key={team.id}
            lead={<IconTile icon={Users} />}
            title={team.name}
            description={team.detail}
            trailing={team.lockReason ? locked(team.lockReason) : <RemoveButton label={`Remove ${team.name}`} onClick={() => onRemoveTeam(team.id)} />}
            testId="role-holder-team"
          />
        ))}
        {/* Locked, with why (P4, C5): the pickers stay where they are. */}
        <div className="flex flex-wrap items-center gap-2 px-5 py-3" data-testid="role-holders-add">
          <span title={peopleLockReason ?? undefined}><AddPicker kind="person" options={addablePeople} disabled={Boolean(peopleLockReason)} onAdd={onAddPeople} /></span>
          <span title={teamsLockReason ?? undefined}><AddPicker kind="team" options={addableTeams} disabled={Boolean(teamsLockReason)} onAdd={onAddTeams} /></span>
          {lockReasons.length > 0 ? (
            <span className="flex min-w-0 basis-full items-start gap-1.5 text-[12px] text-gray-500" data-testid="role-holders-locked">
              <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="flex min-w-0 flex-col">{lockReasons.map((reason) => <span key={reason}>{reason}</span>)}</span>
            </span>
          ) : null}
        </div>
      </ItemPanel>
    </ItemSection>
  );
}
