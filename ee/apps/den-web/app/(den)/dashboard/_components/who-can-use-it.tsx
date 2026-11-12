"use client";

import { Globe, Users } from "lucide-react";
import { useMemo } from "react";
import { DenSwitch } from "../../_components/ui/switch";
import { permissionLockReason, type DenOrgMember, type DenOrgTeam } from "../../_lib/den-org";
import { AccessRow as Row, AddPicker, Avatar, IconTile, RemoveButton } from "./access-rows";
import { type AccessDraft, peopleLabel } from "./access-summary";

/**
 * The one Who can use it block. It edits a draft; each surface decides when
 * to save (a Share page saves on its footer button, Manage pages save on add
 * and remove).
 */
export function WhoCanUseIt({
  value,
  onChange,
  members,
  teams,
  owner,
  canShareWithEveryone,
  everyoneOffDescription = "Off. Only you and the people below can use it.",
  disabled = false,
}: {
  value: AccessDraft;
  onChange: (next: AccessDraft) => void;
  members: readonly DenOrgMember[];
  teams: readonly DenOrgTeam[];
  owner: { id: string; name: string; isYou: boolean } | null;
  canShareWithEveryone: boolean;
  everyoneOffDescription?: string;
  disabled?: boolean;
}) {
  const people = useMemo(
    () => value.memberIds
      .filter((id) => id !== owner?.id)
      .flatMap((id) => {
        const member = members.find((entry) => entry.id === id);
        return member ? [member] : [];
      }),
    [members, owner?.id, value.memberIds],
  );
  const addedTeams = useMemo(
    () => value.teamIds.flatMap((id) => {
      const team = teams.find((entry) => entry.id === id);
      return team ? [team] : [];
    }),
    [teams, value.teamIds],
  );
  const personOptions = members
    .filter((member) => member.id !== owner?.id && !value.memberIds.includes(member.id) && member.userId)
    .map((member) => ({ id: member.id, name: member.user.name || member.user.email, detail: member.user.email }));
  const teamOptions = teams
    .filter((team) => !value.teamIds.includes(team.id))
    .map((team) => ({ id: team.id, name: team.name, detail: peopleLabel(team.memberIds.length) }));

  const everyoneDescription = value.orgWide
    ? "On. Everyone in the organization can use it."
    : canShareWithEveryone ? everyoneOffDescription : permissionLockReason("sharing.share_org_wide");

  return (
    <div className="flex flex-col divide-y divide-[var(--den-list-line)] border-y border-[var(--den-list-line)]" data-testid="who-can-use-it">
      <Row
        lead={<IconTile icon={Globe} />}
        title="Everyone in the organization"
        description={everyoneDescription}
        trailing={(
          <DenSwitch
            checked={value.orgWide}
            disabled={disabled || (!canShareWithEveryone && !value.orgWide)}
            onChange={(orgWide) => onChange({ ...value, orgWide })}
            aria-label="Everyone in the organization"
            testId="access-everyone"
          />
        )}
      />
      {owner ? (
        <Row
          lead={<Avatar name={owner.name} owner />}
          title={owner.isYou ? `${owner.name} (you)` : owner.name}
          description="Can change and remove it"
          trailing={<span className="shrink-0 text-[13px] text-[var(--dls-text-secondary)]">Owner</span>}
          testId="access-owner"
        />
      ) : null}
      {value.orgWide ? null : (
        <>
          {people.map((member) => (
            <Row
              key={member.id}
              lead={<Avatar name={member.user.name || member.user.email} />}
              title={member.user.name || member.user.email}
              description={member.user.email}
              trailing={<RemoveButton label={`Remove ${member.user.name || member.user.email}`} disabled={disabled} onClick={() => onChange({ ...value, memberIds: value.memberIds.filter((id) => id !== member.id) })} />}
              testId="access-person"
            />
          ))}
          {addedTeams.map((team) => (
            <Row
              key={team.id}
              lead={<IconTile icon={Users} />}
              title={team.name}
              description={`${peopleLabel(team.memberIds.length)}, and anyone who joins later`}
              trailing={<RemoveButton label={`Remove ${team.name}`} disabled={disabled} onClick={() => onChange({ ...value, teamIds: value.teamIds.filter((id) => id !== team.id) })} />}
              testId="access-team"
            />
          ))}
          <div className="flex flex-wrap items-center gap-2 py-3">
            <AddPicker
              kind="person"
              options={personOptions}
              disabled={disabled}
              onAdd={(ids) => onChange({ ...value, memberIds: [...value.memberIds, ...ids] })}
            />
            <AddPicker
              kind="team"
              options={teamOptions}
              disabled={disabled}
              onAdd={(ids) => onChange({ ...value, teamIds: [...value.teamIds, ...ids] })}
            />
          </div>
        </>
      )}
    </div>
  );
}
