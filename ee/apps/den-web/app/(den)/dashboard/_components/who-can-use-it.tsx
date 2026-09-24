"use client";

import { Popover } from "@base-ui/react/popover";
import { Check, Globe, Plus, Search, Users, type LucideIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenSwitch } from "../../_components/ui/switch";
import type { DenOrgMember, DenOrgTeam } from "../../_lib/den-org";
import { type AccessDraft, peopleLabel } from "./access-summary";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

function Avatar({ name, owner = false }: { name: string; owner?: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${owner ? "bg-[#011627] text-white" : "bg-gray-100 text-gray-600"}`}
    >
      {initials(name)}
    </span>
  );
}

function Row({ lead, title, description, trailing, testId }: {
  lead: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  trailing?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex items-center gap-3.5 px-5 py-3" data-testid={testId}>
      {lead}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-medium leading-5 text-gray-900">{title}</p>
        {description ? <p className="truncate text-[13px] leading-[18px] text-gray-500">{description}</p> : null}
      </div>
      {trailing}
    </div>
  );
}

function IconTile({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-50 text-gray-500">
      <Icon className="h-4 w-4" strokeWidth={1.8} />
    </span>
  );
}

function RemoveButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
    >
      Remove
    </button>
  );
}

type PickerOption = { id: string; name: string; detail: string };

function AddPicker({ kind, options, disabled, onAdd }: {
  kind: "person" | "team";
  options: PickerOption[];
  disabled?: boolean;
  onAdd: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const noun = kind === "person" ? "people" : "teams";
  const visible = options.filter((option) => `${option.name} ${option.detail}`.toLowerCase().includes(query.trim().toLowerCase()));
  const chosen = options.filter((option) => selected.includes(option.id));
  const addLabel = chosen.length === 1
    ? `Add ${chosen[0].name}`
    : chosen.length > 1 ? `Add ${chosen.length} ${noun}` : "Add";

  function close() {
    setOpen(false);
    setQuery("");
    setSelected([]);
  }

  return (
    <Popover.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <Popover.Trigger
        disabled={disabled}
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 text-[12px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        {kind === "person" ? "Add person" : "Add team"}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={8} className="z-50">
          <Popover.Popup
            data-testid={`access-add-${kind}-popover`}
            className="w-[320px] max-w-[calc(100vw-2rem)] rounded-2xl border border-gray-200 bg-white p-2 shadow-[0_8px_24px_rgba(15,23,42,0.08)] outline-none"
          >
            <Popover.Title className="sr-only">{kind === "person" ? "Add people" : "Add teams"}</Popover.Title>
            <label className="flex h-9 items-center gap-2 rounded-lg border border-gray-200 px-3 focus-within:border-gray-400">
              <Search className="h-3.5 w-3.5 text-gray-400" aria-hidden />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={kind === "person" ? "Search people" : "Search teams"}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-gray-900 outline-none placeholder:text-gray-400"
              />
            </label>
            <div className="mt-1 max-h-[240px] overflow-y-auto" role="listbox" aria-multiselectable>
              {visible.length === 0 ? (
                <p className="px-3 py-4 text-center text-[12px] text-gray-500">
                  {options.length === 0 ? `Everyone is already added.` : `No ${noun} match.`}
                </p>
              ) : visible.map((option) => {
                const isSelected = selected.includes(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => setSelected((current) => isSelected ? current.filter((id) => id !== option.id) : [...current, option.id])}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-gray-50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-gray-900">{option.name}</span>
                      <span className="block truncate text-[12px] text-gray-500">{option.detail}</span>
                    </span>
                    {isSelected ? <Check className="h-4 w-4 shrink-0 text-gray-900" aria-hidden /> : null}
                  </button>
                );
              })}
            </div>
            <div className="mt-1 flex items-center justify-between gap-3 border-t border-gray-100 px-2 pt-2">
              <span className="text-[12px] text-gray-500">
                {chosen.length === 0 ? `Pick ${noun}` : `${chosen.length} ${chosen.length === 1 ? (kind === "person" ? "person" : "team") : noun} selected`}
              </span>
              <DenButton
                size="sm"
                disabled={chosen.length === 0}
                onClick={() => {
                  onAdd(chosen.map((option) => option.id));
                  close();
                }}
              >
                {addLabel}
              </DenButton>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

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
    : canShareWithEveryone ? everyoneOffDescription : "Only admins can share with everyone.";

  return (
    <div className="flex flex-col divide-y divide-gray-100 rounded-2xl border border-gray-100 bg-white" data-testid="who-can-use-it">
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
          trailing={<span className="shrink-0 text-[12px] text-gray-500">Owner</span>}
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
          <div className="flex flex-wrap items-center gap-2 px-5 py-3">
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
