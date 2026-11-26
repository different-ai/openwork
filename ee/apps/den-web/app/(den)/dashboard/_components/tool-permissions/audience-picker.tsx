import { Select } from "@base-ui/react/select";
import type { ToolPermissionSubject } from "@openwork/types/den/tool-permissions";
import { Check, ChevronDown } from "lucide-react";
import { useId } from "react";
import { denDropdownFieldCompactClass, denDropdownListClass, denDropdownMenuBaseClass, denDropdownRowBaseClass } from "../../../_components/ui/dropdown-styles";
import type { DenOrgContext } from "../../../_lib/den-org";

export const everyone: ToolPermissionSubject = { kind: "organization" };

function subjectKey(subject: ToolPermissionSubject): string {
  return subject.kind === "organization" ? "everyone" : `${subject.kind}:${subject.id}`;
}

type Option = { label: string; subject: ToolPermissionSubject };

export function AudiencePicker({ org, subject, disabled, onChange }: { org: DenOrgContext; subject: ToolPermissionSubject; disabled: boolean; onChange: (subject: ToolPermissionSubject) => void }) {
  const labelId = useId();
  const all = { label: `Everyone in ${org.organization.name}`, subject: everyone };
  const teams = org.teams.map(({ id, name }): Option => ({ label: name, subject: { kind: "team", id } }));
  const people = org.members.map(({ id, user }): Option => ({ label: user.name.trim() || user.email || "Unnamed member", subject: { kind: "member", id } }));
  const groups = [[all], teams.sort((a, b) => a.label.localeCompare(b.label)), people.sort((a, b) => a.label.localeCompare(b.label))];
  const items = groups.flat().map(({ label, subject: entry }) => ({ label, value: subjectKey(entry), subject: entry }));
  return <div className="flex w-fit max-w-full min-w-0 items-center gap-2">
    <span id={labelId} className="text-[13px] font-medium">For</span>
    <Select.Root items={items} value={subjectKey(subject)} disabled={disabled} onValueChange={(key) => {
      const next = items.find((item) => item.value === key);
      if (next) onChange(next.subject);
    }}>
      <Select.Trigger data-tool-permissions-audience="" aria-labelledby={labelId}
        className={`${denDropdownFieldCompactClass} flex w-auto min-w-0 items-center justify-between gap-3 rounded-lg pr-3`}>
        <Select.Value className="truncate" />
        <Select.Icon><ChevronDown className="size-4 text-[var(--dls-text-secondary)]" aria-hidden /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner align="start" sideOffset={4} alignItemWithTrigger={false} className="z-50 max-w-[var(--available-width)] min-w-[var(--anchor-width)]">
          <Select.Popup className={denDropdownMenuBaseClass}>
            <Select.List className={denDropdownListClass}>
              {groups.map((group, index) => group.length > 0 ? <Select.Group key={index}>
                {index > 0 ? <Select.GroupLabel className="px-3 py-1 text-xs text-[var(--dls-text-secondary)]">{index === 1 ? "Teams" : "People"}</Select.GroupLabel> : null}
                {group.map(({ subject: entry, label }) => <Select.Item key={subjectKey(entry)} value={subjectKey(entry)} label={label}
                  className={`${denDropdownRowBaseClass} min-h-9 cursor-default items-center text-[13px] data-highlighted:bg-[var(--dls-hover)]`}>
                  <Select.ItemText className="min-w-0 truncate">{label}</Select.ItemText>
                  <Select.ItemIndicator><Check className="size-4 shrink-0" aria-hidden /></Select.ItemIndicator>
                </Select.Item>)}
              </Select.Group> : null)}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  </div>;
}
