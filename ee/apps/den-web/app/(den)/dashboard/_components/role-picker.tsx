"use client";

import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown, LockKeyhole, Search } from "lucide-react";
import { useState, type ReactNode } from "react";

export type RolePickerOption = {
  value: string;
  label: string;
  caption: string | null;
  disabled: boolean;
  lockReason?: string | null;
};

/** One searchable, trigger-width role menu for people and teams. */
export function RolePicker({ value, onChange, options, label, trigger, disabled, footer, open: controlledOpen, onOpenChange, testId = "member-role" }: {
  value: string;
  onChange: (value: string) => void;
  options: readonly RolePickerOption[];
  label: string;
  trigger?: string;
  disabled?: boolean;
  footer?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  testId?: string;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const [query, setQuery] = useState("");
  const open = controlledOpen ?? localOpen;
  const current = options.find((option) => option.value === value);
  function changeOpen(next: boolean) {
    setLocalOpen(next);
    setQuery("");
    onOpenChange?.(next);
  }
  const needle = query.trim().toLowerCase();
  const matches = options.filter((option) => `${option.label} ${option.caption ?? ""}`.toLowerCase().includes(needle));
  const row = (option: RolePickerOption) => (
    <button key={option.value} type="button" role="option" aria-selected={value === option.value}
      aria-disabled={option.disabled} disabled={option.disabled} title={option.lockReason ?? option.label}
      data-testid={`${testId}-option-${option.value}`}
      onClick={() => { onChange(option.value); if (!footer) changeOpen(false); }}
      className={`flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-left disabled:cursor-not-allowed ${value === option.value ? "bg-gray-100" : "hover:bg-gray-50"}`}>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-gray-900" title={option.label}>{option.label}</span>
        {option.lockReason || option.caption ? <span className="block truncate text-[12px] text-gray-500" title={option.lockReason ?? option.caption ?? undefined}>{option.lockReason ?? option.caption}</span> : null}
      </span>
      {option.disabled ? <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-gray-500" aria-hidden /> : value === option.value ? <Check className="h-4 w-4 shrink-0" aria-hidden /> : null}
    </button>
  );
  return <Popover.Root open={open} onOpenChange={changeOpen}>
    <Popover.Trigger disabled={disabled} aria-label={label} data-testid={`${testId}-change`} title={trigger ?? current?.label}
      className="flex h-10 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white px-3 text-left text-[13px] text-gray-900 focus-visible:outline-2 focus-visible:outline-gray-400">
      <span className="min-w-0 truncate">{trigger ?? current?.label ?? "Role not verified"}</span><ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
    </Popover.Trigger>
    <Popover.Portal><Popover.Positioner side="bottom" align="start" sideOffset={8} className="z-50 max-w-[var(--available-width)]">
      <Popover.Popup data-testid={`${testId}-choice`} className="flex max-h-[var(--available-height)] w-[var(--anchor-width)] max-w-[var(--available-width)] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white p-2 shadow-lg outline-none">
        <Popover.Title className="sr-only">{label}</Popover.Title>
        <label className="flex h-9 shrink-0 items-center gap-2 rounded-lg border border-gray-200 px-3 focus-within:border-gray-400">
          <Search className="h-3.5 w-3.5 shrink-0 text-gray-500" aria-hidden />
          <input autoFocus aria-label="Search roles" placeholder="Search roles" value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
        </label>
        <div className="mt-1 min-h-0 overflow-y-auto overflow-x-hidden" role="listbox" aria-label={label}>
          {matches.filter((option) => option.value === "member" || option.value === "admin").map(row)}
          {matches.some((option) => option.value !== "member" && option.value !== "admin") ? <p className="px-3 pb-1 pt-2 text-[12px] font-medium text-gray-500">Custom roles</p> : null}
          {matches.filter((option) => option.value !== "member" && option.value !== "admin").map(row)}
          {matches.length === 0 ? <p className="px-3 py-4 text-[12px] text-gray-500">No roles match “{query.trim()}”.</p> : null}
        </div>
        {footer ? <div className="mt-1 shrink-0 border-t border-gray-100 pt-2">{footer}</div> : null}
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>;
}
