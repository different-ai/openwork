import { Dialog } from "@base-ui/react/dialog";
import type { PersonalAgentAdminItem, SetPersonalAgentAudience } from "@openwork/types/den/personal-agents";
import { useId, useState } from "react";
import { DenCheckbox } from "../../../_components/ui/checkbox";
import { DenSwitch } from "../../../_components/ui/switch";
import type { DenOrgTeam } from "../../../_lib/den-org";
import { ActionDialog, type DialogProps } from "./dialogs";

const muted = "text-[13px] text-[var(--dls-text-secondary)]";

function SidebarSwitch({ audience, checked, disabled, onChange }: {
  audience: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const hint = useId();
  return <div className="flex items-center justify-between gap-3 py-1 pl-5 text-[13px]">
    <div>
      <div>Add to their sidebar</div>
      <div id={hint} className={muted}>They can&apos;t hide it.</div>
    </div>
    <DenSwitch size="sm" aria-label={`Add to their sidebar: ${audience}`} aria-describedby={hint}
      checked={checked} disabled={disabled} onChange={onChange} />
  </div>;
}

function TeamAccessRow({ team, checked, autoAdd, busy, onCheck, onAutoAdd }: {
  team: DenOrgTeam;
  checked: boolean;
  autoAdd: boolean;
  busy: boolean;
  onCheck: (checked: boolean) => void;
  onAutoAdd: (checked: boolean) => void;
}) {
  const id = useId();
  return <li className="py-1">
    <div className="flex min-h-8 items-center gap-2 text-[13px]">
      <DenCheckbox id={id} checked={checked} disabled={busy} onCheckedChange={onCheck} />
      <label htmlFor={id} className="break-words">{team.name}</label>
    </div>
    {checked ? <SidebarSwitch audience={team.name} checked={autoAdd} disabled={busy} onChange={onAutoAdd} /> : null}
  </li>;
}

export function AccessDialog({ item, orgName, teams, onSave, ...dialog }: DialogProps & {
  item: PersonalAgentAdminItem;
  orgName: string;
  teams: readonly DenOrgTeam[];
  onSave: (audience: SetPersonalAgentAudience) => void;
}) {
  const [organization, setOrganization] = useState(item.audience.organization);
  const [autoAddOrganization, setAutoAddOrganization] = useState(item.audience.autoAddOrganization);
  const [selectedTeams, setSelectedTeams] = useState(() => new Map(item.audience.teams.map(({ teamId, autoAdd }) => [teamId, autoAdd])));
  const chosen = teams.flatMap(({ id }) => selectedTeams.has(id) ? [{ teamId: id, autoAdd: selectedTeams.get(id) === true }] : []);
  const tooMany = chosen.length > 50;
  const everyone = `Everyone in ${orgName}`;

  function updateTeam(id: string, autoAdd: boolean | null) {
    setSelectedTeams((previous) => {
      const next = new Map(previous);
      if (autoAdd === null) next.delete(id);
      else next.set(id, autoAdd);
      return next;
    });
  }

  return <ActionDialog {...dialog} access title={`Who can use ${item.agent.name}`} action="Save" disabled={tooMany}
    onSave={() => onSave({ organization, autoAddOrganization: organization && autoAddOrganization, teams: chosen })}>
    <Dialog.Description className={muted}>People it is shared with one by one keep their access. The owner manages those in the app.</Dialog.Description>
    <div className="border-y border-[var(--dls-border)] py-1">
      <div className="flex min-h-9 items-center justify-between gap-3 text-[13px] font-medium">
        <span className="break-words">{everyone}</span>
        <DenSwitch aria-label={everyone} checked={organization} disabled={dialog.busy} onChange={setOrganization} />
      </div>
      {organization ? <SidebarSwitch audience={everyone} checked={autoAddOrganization} disabled={dialog.busy} onChange={setAutoAddOrganization} /> : null}
    </div>
    {teams.length ? <div className="min-w-0">
      <h3 className="text-[13px] font-medium">Teams</h3>
      <ul className="max-h-64 divide-y divide-[var(--dls-border)] overflow-y-auto">
        {teams.map((team) => <TeamAccessRow key={team.id} team={team} checked={selectedTeams.has(team.id)}
          autoAdd={selectedTeams.get(team.id) === true} busy={dialog.busy}
          onCheck={(checked) => updateTeam(team.id, checked ? false : null)} onAutoAdd={(autoAdd) => updateTeam(team.id, autoAdd)} />)}
      </ul>
      {tooMany ? <p role="status" className={muted}>Choose up to 50 teams.</p> : null}
    </div> : null}
  </ActionDialog>;
}
