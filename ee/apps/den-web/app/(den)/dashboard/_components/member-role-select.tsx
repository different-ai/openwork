"use client";

import type { ReactNode } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenSelect } from "../../_components/ui/select";
import type { MemberRoleOption } from "./team-roles";
import { RolePicker } from "./role-picker";

/**
 * The one picker for a person's own role, used by Invite and Edit role so
 * both list the same roles (see memberRoleOptions). The menu is exactly as
 * wide as the field; long role names truncate and show in full on hover.
 */
export function MemberRoleSelect({ value, onChange, options, label = "Role", searchable = false }: {
  value: string;
  onChange: (value: string) => void;
  options: readonly MemberRoleOption[];
  label?: string;
  searchable?: boolean;
}) {
  if (searchable) return <RolePicker value={value} onChange={onChange} options={options} label={label} />;
  return (
    <DenSelect aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} menuWidth="trigger">
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled} title={option.label}>
          {option.label}
          {option.caption ? <span className="ml-1.5 font-normal text-gray-500">{option.caption}</span> : null}
        </option>
      ))}
    </DenSelect>
  );
}

/**
 * Members › Edit role: the person's own role, and the roles their teams give
 * them (sharedRoles), with Cancel and Save member.
 */
export function MemberRoleEditor({ memberName, value, onChange, options, teamRoles, onCancel, onSave, saving, searchable, teamChoice, blocked }: {
  memberName: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly MemberRoleOption[];
  /** What the person's teams add, e.g. "test Permissions via Engineering", and a way to change it. */
  teamRoles?: ReactNode;
  onCancel: () => void;
  onSave: () => void | Promise<void>;
  saving: boolean;
  searchable?: boolean;
  teamChoice?: ReactNode;
  blocked?: boolean;
}) {
  return (
    <DenCard className="mb-6" data-testid="member-role-editor">
      <form
        className="flex flex-wrap items-end justify-between gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave();
        }}
      >
        <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-3 sm:w-[280px]" data-testid="member-role-select">
          <span className="truncate text-[14px] font-medium text-gray-700" title={`Role for ${memberName}`}>
            Organization role for {memberName}
          </span>
          <MemberRoleSelect value={value} onChange={onChange} options={options} label={`Role for ${memberName}`} searchable={searchable} />
        </div>
        {teamChoice}
        <div className="flex flex-wrap gap-2">
          <DenButton variant="secondary" onClick={onCancel}>Cancel</DenButton>
          <DenButton type="submit" loading={saving} disabled={blocked} data-testid="member-role-save">
            Save member
          </DenButton>
        </div>
        {teamRoles ? <div className="w-full min-w-0 text-[13px] text-gray-500">{teamRoles}</div> : null}
      </form>
    </DenCard>
  );
}
