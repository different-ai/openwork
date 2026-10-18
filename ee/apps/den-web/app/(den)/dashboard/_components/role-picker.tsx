"use client";

import { Popover } from "@base-ui/react/popover";
import { Command } from "cmdk";
import { Check, ChevronDown, LockKeyhole, Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import { DenButton } from "../../_components/ui/button";

export type RolePickerOption = {
  value: string;
  label: string;
  caption: string | null;
  disabled: boolean;
  lockReason?: string | null;
};

/** Popover owns placement; Command owns search, active options and keyboard selection. */
export function RolePicker({ value, onChange, options, label, trigger, disabled, footer, open: controlledOpen, onOpenChange, testId = "member-role", inventoryState = "ready", onRetryInventory }: {
  value: string;
  onChange: (value: string) => void;
  options: readonly RolePickerOption[];
  inventoryState?: "ready" | "loading" | "error" | "limited";
  onRetryInventory?: () => void;
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
  const [page, setPage] = useState(0);
  const open = controlledOpen ?? localOpen;
  const current = options.find((option) => option.value === value);
  function changeOpen(next: boolean) {
    setLocalOpen(next);
    setQuery("");
    setPage(0);
    onOpenChange?.(next);
  }
  const needle = query.trim().toLocaleLowerCase();
  // Search the whole loaded inventory before taking a bounded rendered page.
  const matches = options.filter((option) => `${option.label} ${option.caption ?? ""}`.toLocaleLowerCase().includes(needle));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matches.length / 50) - 1));
  const visible = matches.slice(currentPage * 50, (currentPage + 1) * 50);

  return <Popover.Root open={open} onOpenChange={changeOpen}>
    <Popover.Trigger disabled={disabled} aria-label={label} data-testid={`${testId}-change`} title={trigger ?? current?.label}
      className="flex h-10 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white px-3 text-left text-[13px] text-gray-900 focus-visible:outline-2 focus-visible:outline-gray-400">
      <span className="min-w-0 truncate">{trigger ?? current?.label ?? "Role not verified"}</span><ChevronDown className="size-3.5 shrink-0" aria-hidden />
    </Popover.Trigger>
    <Popover.Portal><Popover.Positioner side="bottom" align="start" sideOffset={8} className="z-50 max-w-[var(--available-width)]">
      <Popover.Popup data-testid={`${testId}-choice`} className="flex max-h-[var(--available-height)] w-[var(--anchor-width)] max-w-[var(--available-width)] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white p-2 shadow-lg outline-none">
        <Popover.Title className="sr-only">{label}</Popover.Title>
        <Command label={label} shouldFilter={false} loop defaultValue={value} className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 rounded-lg border border-gray-200 px-3 focus-within:border-gray-400">
            <Search className="size-3.5 shrink-0 text-gray-500" aria-hidden />
            <Command.Input autoFocus aria-label="Search roles" placeholder="Search roles" value={query} onValueChange={(next) => { setQuery(next); setPage(0); }} className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
          </div>
          <Command.List label={label} className="mt-1 min-h-0 overflow-y-auto overflow-x-hidden">
            {visible.map((option) => <Command.Item key={option.value} value={option.value} disabled={option.disabled}
              title={option.lockReason ?? option.label} data-testid={`${testId}-option-${option.value}`}
              onSelect={() => { onChange(option.value); if (!footer) changeOpen(false); }}
              className="flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-60 data-[selected=true]:bg-gray-100">
              <span className="min-w-0 flex-1">
                <span className="block break-words text-[13px] font-medium text-gray-900">{option.label}</span>
                {option.lockReason || option.caption ? <span className="block break-words text-[12px] text-gray-500">{option.lockReason ?? option.caption}</span> : null}
              </span>
              {option.disabled ? <LockKeyhole className="size-3.5 shrink-0 text-gray-500" aria-hidden /> : value === option.value ? <Check className="size-4 shrink-0 text-gray-900" aria-hidden /> : null}
            </Command.Item>)}
            {matches.length === 0 ? <Command.Empty className="px-3 py-4 text-[12px] text-gray-500">{inventoryState === "ready" ? `No roles match “${query.trim()}”.` : "Role results aren't verified."}</Command.Empty> : null}
          </Command.List>
        </Command>
        <div className="mt-1 flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-2 py-2 text-[12px] text-gray-500" data-testid="role-picker-completeness" role="status">
          <span>{inventoryState === "ready" ? <>{matches.length ? `${currentPage * 50 + 1}–${Math.min((currentPage + 1) * 50, matches.length)} of ${matches.length}` : "0"} roles{needle ? " matching" : ""}; all available roles loaded</> : inventoryState === "loading" ? "Checking the complete role list" : inventoryState === "limited" ? "Organization roles only; custom roles need View permissions" : "Couldn't verify the complete role list"}</span>
          {inventoryState === "error" && onRetryInventory ? <DenButton size="xs" variant="ghost" onClick={onRetryInventory}>Try again</DenButton> : null}
          {matches.length > 50 ? <span className="flex gap-2"><DenButton size="xs" variant="ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous roles</DenButton><DenButton size="xs" variant="ghost" disabled={(currentPage + 1) * 50 >= matches.length} onClick={() => setPage(currentPage + 1)}>Next roles</DenButton></span> : null}
        </div>
        {footer ? <div className="mt-1 shrink-0 border-t border-gray-100 pt-2">{footer}</div> : null}
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>;
}
