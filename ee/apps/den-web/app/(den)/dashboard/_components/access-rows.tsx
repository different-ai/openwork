"use client";

import { Popover } from "@base-ui/react/popover";
import { Check, Plus, Search, Users, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { ItemPanel } from "./item-list";

/**
 * Rows and pickers shared by everything that lists people and teams with
 * access: the Who can use it block, and the people in a role.
 */

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

export function Avatar({ name, owner = false }: { name: string; owner?: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${owner ? "bg-[#011627] text-white" : "bg-gray-100 text-gray-600"}`}
    >
      {initials(name)}
    </span>
  );
}

export function AccessRow({ lead, title, description, trailing, testId }: {
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

export function IconTile({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-50 text-gray-500">
      <Icon className="h-4 w-4" strokeWidth={1.8} />
    </span>
  );
}

export function RemoveButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
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

export type PersonChoice = { id: string; name: string; email: string };

/**
 * The people in a team or a role: one row each with Remove, then Add person.
 * Used by Create role and by the team form, so both pick people the same way.
 */
export function PeopleField({ people, chosenIds, onChange, rowTestId }: {
  /** Everyone who can be added, in display order. */
  people: readonly PersonChoice[];
  chosenIds: readonly string[];
  onChange: (ids: string[]) => void;
  rowTestId?: string;
}) {
  const chosen = chosenIds.flatMap((id) => people.find((person) => person.id === id) ?? []);
  const addable = people
    .filter((person) => !chosenIds.includes(person.id))
    .map((person) => ({ id: person.id, name: person.name, detail: person.email }));
  return (
    <ItemPanel>
      {chosen.map((person) => (
        <AccessRow
          key={person.id}
          lead={<Avatar name={person.name} />}
          title={person.name}
          description={person.email}
          trailing={<RemoveButton label={`Remove ${person.name}`} onClick={() => onChange(chosenIds.filter((id) => id !== person.id))} />}
          testId={rowTestId}
        />
      ))}
      <div className="flex px-5 py-3">
        <AddPicker kind="person" options={addable} onAdd={(ids) => onChange([...chosenIds, ...ids])} />
      </div>
    </ItemPanel>
  );
}

export type TeamChoice = { id: string; name: string; detail: string };

/** The teams a role goes to: one row each with Remove, then Add team (sharedRoles Create role). */
export function TeamsField({ teams, chosenIds, onChange, rowTestId }: {
  teams: readonly TeamChoice[];
  chosenIds: readonly string[];
  onChange: (ids: string[]) => void;
  rowTestId?: string;
}) {
  const chosen = chosenIds.flatMap((id) => teams.find((team) => team.id === id) ?? []);
  const addable = teams.filter((team) => !chosenIds.includes(team.id));
  return (
    <ItemPanel>
      {chosen.map((team) => (
        <AccessRow
          key={team.id}
          lead={<IconTile icon={Users} />}
          title={team.name}
          description={team.detail}
          trailing={<RemoveButton label={`Remove ${team.name}`} onClick={() => onChange(chosenIds.filter((id) => id !== team.id))} />}
          testId={rowTestId}
        />
      ))}
      <div className="flex px-5 py-3">
        <AddPicker kind="team" options={addable} onAdd={(ids) => onChange([...chosenIds, ...ids])} />
      </div>
    </ItemPanel>
  );
}

export type PickerOption = { id: string; name: string; detail: string };

export function AddPicker({ kind, options, disabled, onAdd, triggerLabel, actionLabel, showConsequences = false }: {
  kind: "person" | "team";
  options: PickerOption[];
  disabled?: boolean;
  onAdd: (ids: string[]) => void | Promise<void>;
  triggerLabel?: string;
  actionLabel?: string;
  showConsequences?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setError(null);
  }

  async function submit() {
    if (busy || chosen.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(chosen.map((option) => option.id));
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't finish. Your selections are kept; try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={(next) => { if (!busy) { if (next) setOpen(true); else close(); } }}>
      <Popover.Trigger
        disabled={disabled}
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 text-[12px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        {triggerLabel ?? (kind === "person" ? "Add person" : "Add team")}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={8} className="z-50">
          <Popover.Popup
            data-testid={`access-add-${kind}-popover`}
            className="w-[320px] max-w-[calc(100vw-2rem)] rounded-2xl border border-gray-200 bg-white p-2 shadow-[0_8px_24px_rgba(15,23,42,0.08)] outline-none"
          >
            <Popover.Title className="sr-only">{kind === "person" ? "Add people" : "Add teams"}</Popover.Title>
            <label className="flex h-9 items-center gap-2 rounded-lg border border-gray-200 px-3 focus-within:border-gray-400">
              <Search className="h-3.5 w-3.5 text-gray-500" aria-hidden />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={kind === "person" ? "Search people" : "Search teams"}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-gray-900 outline-none placeholder:text-gray-500"
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
                    disabled={busy}
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
            {showConsequences && chosen.length > 0 ? <ul className="my-2 max-h-32 overflow-y-auto px-2 text-[12px] text-gray-600" aria-label="Changes to review">{chosen.map((option) => <li key={option.id} className="break-words py-1">{option.name}: {option.detail}</li>)}</ul> : null}
            {error ? <DenNotice tone="error" message={error} /> : null}
            <div className="mt-1 flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-2 pt-2">
              <span className="text-[12px] text-gray-500">
                {chosen.length === 0 ? `Pick ${noun}` : `${chosen.length} ${chosen.length === 1 ? (kind === "person" ? "person" : "team") : noun} selected`}
              </span>
              <DenButton
                size="sm"
                disabled={chosen.length === 0 || busy}
                loading={busy}
                onClick={() => void submit()}
              >
                {actionLabel ?? addLabel}
              </DenButton>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

