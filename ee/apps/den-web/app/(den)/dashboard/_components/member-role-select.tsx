"use client";

import type { ComponentProps, ReactNode } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import type { MemberRoleOption } from "./team-roles";
import { RolePicker } from "./role-picker";

/**
 * The one picker for a person's own role, used by Invite and Edit role so
 * both list the same roles (see memberRoleOptions). The menu is exactly as
 * wide as the field; long role names truncate and show in full on hover.
 */
type RoleInventory = Pick<ComponentProps<typeof RolePicker>, "inventoryState" | "onRetryInventory">;

export function MemberRoleSelect({ value, onChange, options, label = "Role", inventoryState, onRetryInventory }: {
  value: string;
  onChange: (value: string) => void;
  options: readonly MemberRoleOption[];
  label?: string;
  searchable?: boolean;
} & RoleInventory) {
  return <RolePicker value={value} onChange={onChange} options={options} label={label} inventoryState={inventoryState} onRetryInventory={onRetryInventory} />;
}

/**
 * Members › Edit role: the person's own role, and the roles their teams give
 * them (sharedRoles), with Cancel and Save member.
 */
export function MemberRoleEditor({ memberName, value, onChange, options, teamRoles, onCancel, onSave, saving, searchable, teamChoice, blocked, inventoryState, onRetryInventory }: {
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
} & RoleInventory) {
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
          <MemberRoleSelect value={value} onChange={onChange} options={options} label={`Role for ${memberName}`} searchable={searchable} inventoryState={inventoryState} onRetryInventory={onRetryInventory} />
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
