"use client";

import { Combobox } from "@base-ui/react/combobox";
import { Check, Plus, X } from "lucide-react";
import { useRef } from "react";
import {
  denDropdownListClass,
  denDropdownMenuBaseClass,
  denDropdownRowBaseClass,
} from "./dropdown-styles";

type ChipItem = { value: string; label: string; create: boolean };

export type DenChipsComboboxProps = {
  /** Selected values, shown as removable chips in the order chosen. */
  value: readonly string[];
  /** The new selection; the typed query is used up, so clear it here too. */
  onChange: (next: string[]) => void;
  /** Values to choose from; anything typed that isn't one of these can be added. */
  options: readonly string[];
  /** Text typed in the box. Controlled, so a form can keep text that was never entered. */
  query: string;
  onQueryChange: (query: string) => void;
  /** How two values are told apart, for example case-insensitively. */
  toKey?: (value: string) => string;
  /** Cleans typed text before it becomes a value. */
  normalize?: (value: string) => string;
  maxItems?: number;
  maxLength?: number;
  placeholder?: string;
  /** Shown when nothing matches and nothing is typed yet. */
  emptyLabel?: string;
  /** Shown under the list once `maxItems` are chosen. */
  limitLabel?: string;
  ariaLabel: string;
  disabled?: boolean;
  invalid?: boolean;
};

const defaultKey = (value: string) => value.trim().toLowerCase();
const defaultNormalize = (value: string) => value.trim();

/**
 * A multi-select combobox with chips: pick existing values from the list, or
 * type a new one and press Enter. Backspace in the empty box removes the last
 * chip. Built on Base UI's Combobox for keyboard, focus and ARIA behavior;
 * styled like DenCombobox.
 */
export function DenChipsCombobox({
  value,
  onChange,
  options,
  query,
  onQueryChange,
  toKey = defaultKey,
  normalize = defaultNormalize,
  maxItems,
  maxLength,
  placeholder = "Type or choose",
  emptyLabel = "Type and press Enter to add.",
  limitLabel,
  ariaLabel,
  disabled = false,
  invalid = false,
}: DenChipsComboboxProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  /** True once arrow keys moved through the list since the last keystroke: Enter then picks that row. */
  const browsingRef = useRef(false);
  const selectedKeys = new Set(value.map(toKey));
  const full = maxItems !== undefined && value.length >= maxItems;

  const typed = normalize(query);
  const typedKey = toKey(typed);
  const items: ChipItem[] = options.map((option) => ({ value: option, label: option, create: false }));
  // Selected values that aren't options yet (typed in this session) still show as checked rows.
  for (const selected of value) {
    if (!options.some((option) => toKey(option) === toKey(selected))) items.push({ value: selected, label: selected, create: false });
  }
  const filtered = typedKey ? items.filter((item) => toKey(item.label).includes(typedKey)) : items;
  const exact = filtered.find((item) => toKey(item.value) === typedKey);
  // The best match comes first, so Enter picks it: the exact option, or adding what was typed.
  const shown: ChipItem[] = !typedKey
    ? filtered
    : exact
      ? [exact, ...filtered.filter((item) => item !== exact)]
      : [{ value: typed, label: typed, create: true }, ...filtered];
  const selectedItems = value.map((entry) => items.find((item) => toKey(item.value) === toKey(entry)) ?? { value: entry, label: entry, create: false });

  function commit(next: readonly ChipItem[]) {
    const values: string[] = [];
    const keys = new Set<string>();
    for (const item of next) {
      const key = toKey(item.value);
      if (!key || keys.has(key)) continue;
      const adding = !selectedKeys.has(key);
      if (adding && maxItems !== undefined && values.length >= maxItems) continue;
      keys.add(key);
      values.push(item.value);
    }
    // One update: the owner clears its query in onChange. A separate
    // onQueryChange here would race it with a stale copy of the owner's state.
    onChange(values);
  }

  return (
    <Combobox.Root<ChipItem, true>
      multiple
      // The "Add …" row is a real item too, so picking it by arrow or click is a normal selection.
      items={shown[0]?.create ? [shown[0], ...items] : items}
      filteredItems={shown}
      value={selectedItems}
      onValueChange={(next) => commit(next)}
      inputValue={query}
      onInputValueChange={(next, details) => {
        // Only typing changes the query. Base UI clears the box when the list
        // closes (reason input-clear); keep the text so a form can save it.
        if (details.reason === "input-change") {
          browsingRef.current = false;
          onQueryChange(next);
        }
      }}
      isItemEqualToValue={(item, selected) => toKey(item.value) === toKey(selected.value)}
      itemToStringLabel={(item) => item.label}
      itemToStringValue={(item) => item.value}
      autoHighlight
      disabled={disabled}
    >
      <Combobox.Chips
        ref={anchorRef}
        aria-invalid={invalid || undefined}
        className={[
          "flex min-h-[42px] w-full flex-wrap items-center gap-1.5 rounded-lg border bg-white px-2 py-1.5",
          "transition-[border-color,box-shadow] focus-within:border-gray-300 focus-within:ring-2 focus-within:ring-gray-900/5",
          invalid ? "border-amber-300" : "border-gray-200",
          disabled ? "cursor-not-allowed opacity-60" : "cursor-text",
        ].join(" ")}
      >
        {selectedItems.map((item) => (
          <Combobox.Chip
            key={toKey(item.value)}
            aria-label={item.value}
            className="flex h-6 max-w-full items-center gap-1 rounded-md bg-gray-100 pl-2 pr-0.5 text-[12px] font-medium text-gray-800 outline-hidden data-[highlighted]:bg-gray-200 focus-visible:ring-2 focus-visible:ring-gray-900/10"
          >
            <span className="truncate">{item.value}</span>
            <Combobox.ChipRemove
              aria-label={`Remove ${item.value}`}
              className="flex size-5 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-200 hover:text-gray-900"
            >
              <X size={12} strokeWidth={1.75} aria-hidden="true" />
            </Combobox.ChipRemove>
          </Combobox.Chip>
        ))}
        <Combobox.Input
          aria-label={ariaLabel}
          placeholder={value.length === 0 ? placeholder : undefined}
          maxLength={maxLength}
          autoComplete="off"
          spellCheck={false}
          onKeyDown={(event) => {
            // Enter with text typed adds it: the existing option's spelling when
            // it matches one, else the typed text. After arrowing to a row,
            // Base UI picks that row instead.
            if (event.key === "ArrowDown" || event.key === "ArrowUp") browsingRef.current = true;
            if (event.key !== "Enter" || !typedKey || browsingRef.current) return;
            event.preventDefault();
            event.preventBaseUIHandler();
            if (!selectedKeys.has(typedKey)) commit([...selectedItems, exact ?? { value: typed, label: typed, create: true }]);
            else onQueryChange("");
          }}
          className="h-7 min-w-24 flex-1 bg-transparent px-1 text-[14px] leading-5 text-gray-900 outline-hidden placeholder:text-gray-500 disabled:cursor-not-allowed"
        />
      </Combobox.Chips>

      <Combobox.Portal>
        <Combobox.Positioner
          anchor={anchorRef}
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 w-[var(--anchor-width)] max-w-[var(--available-width)]"
        >
          <Combobox.Popup className={denDropdownMenuBaseClass}>
            <Combobox.Empty className="px-3 py-3 text-[13px] text-gray-500 empty:hidden">
              {emptyLabel}
            </Combobox.Empty>
            <Combobox.List className={`${denDropdownListClass} empty:hidden`}>
              {(item: ChipItem) => {
                const selected = selectedKeys.has(toKey(item.value));
                const blocked = full && !selected;
                return (
                  <Combobox.Item
                    key={item.create ? `create:${toKey(item.value)}` : toKey(item.value)}
                    value={item}
                    disabled={blocked}
                    className={[
                      denDropdownRowBaseClass,
                      "min-h-9 cursor-default items-center py-2 text-[14px] text-gray-900 outline-hidden",
                      "data-[highlighted]:bg-gray-50 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
                    ].join(" ")}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {item.create ? <Plus size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-gray-500" /> : null}
                      <span className="truncate">{item.create ? `Add "${item.label}"` : item.label}</span>
                    </span>
                    {selected && !item.create ? <Check size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-gray-900" /> : null}
                  </Combobox.Item>
                );
              }}
            </Combobox.List>
            {full ? (
              <p className="shrink-0 border-t border-gray-100 px-3 py-2 text-[12px] text-gray-500">{limitLabel ?? `Up to ${maxItems}`}</p>
            ) : null}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
