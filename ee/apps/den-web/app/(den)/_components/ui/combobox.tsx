"use client";

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type FocusEvent, type KeyboardEvent } from "react";
import {
  denDropdownChevronSlotClass,
  denDropdownFieldBaseClass,
  denDropdownFieldOpenClass,
  denDropdownListClass,
  denDropdownMenuBaseClass,
  denDropdownRowActiveClass,
  denDropdownRowBaseClass,
  denDropdownRowIdleClass,
  denDropdownRowSelectedClass,
} from "./dropdown-styles";

export type DenComboboxOption = {
  value: string;
  label: string;
  description?: string;
  meta?: string;
  keywords?: string[];
};

export type DenComboboxProps = {
  value: string;
  options: DenComboboxOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
};

function normalizeQuery(value: string) {
  return value.trim().toLowerCase();
}

function getOptionSearchText(option: DenComboboxOption) {
  return [option.label, option.value, option.description ?? "", ...(option.keywords ?? [])]
    .join(" ")
    .toLowerCase();
}

export function DenCombobox({
  value,
  options,
  onChange,
  placeholder = "Select an option...",
  searchPlaceholder = "Search...",
  emptyLabel = "No options match",
  disabled = false,
  className,
  ariaLabel = "Select option",
}: DenComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hasTypedSinceOpen, setHasTypedSinceOpen] = useState(false);
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const listboxId = useId();

  const selectedOption = useMemo(() => options.find((option) => option.value === value) ?? null, [options, value]);
  const selectedLabel = selectedOption?.label ?? "";
  const normalizedQuery = hasTypedSinceOpen ? normalizeQuery(query) : "";
  const filteredOptions = useMemo(() => {
    if (!normalizedQuery) {
      return options;
    }

    return options.filter((option) => getOptionSearchText(option).includes(normalizedQuery));
  }, [normalizedQuery, options]);

  const activeIndex = activeValue ? filteredOptions.findIndex((option) => option.value === activeValue) : -1;
  const activeDescendant = activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined;
  const inputValue = open ? (hasTypedSinceOpen ? query : selectedLabel) : selectedLabel;

  function focusInput(selectText = false) {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      if (selectText) {
        inputRef.current?.select();
      }
    });
  }

  function openCombobox({ selectText = false }: { selectText?: boolean } = {}) {
    if (disabled) {
      return;
    }

    setOpen(true);
    setHasTypedSinceOpen(false);
    setQuery(selectedLabel);
    if (selectText) {
      focusInput(true);
    }
  }

  function closeCombobox({ focus = false }: { focus?: boolean } = {}) {
    setOpen(false);
    setActiveValue(null);
    setHasTypedSinceOpen(false);
    setQuery(selectedLabel);
    if (focus) {
      focusInput();
    }
  }

  function selectOption(nextValue: string) {
    const nextOption = options.find((option) => option.value === nextValue) ?? null;
    onChange(nextValue);
    setOpen(false);
    setActiveValue(null);
    setHasTypedSinceOpen(false);
    setQuery(nextOption?.label ?? "");
    focusInput();
  }

  function moveActive(step: 1 | -1) {
    if (!filteredOptions.length) {
      return;
    }

    if (!activeValue) {
      setActiveValue(step === 1 ? filteredOptions[0]?.value ?? null : filteredOptions[filteredOptions.length - 1]?.value ?? null);
      return;
    }

    const currentIndex = filteredOptions.findIndex((option) => option.value === activeValue);
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + step + filteredOptions.length) % filteredOptions.length;
    setActiveValue(filteredOptions[nextIndex]?.value ?? null);
  }

  function handleInputFocus(event: FocusEvent<HTMLInputElement>) {
    if (disabled) {
      return;
    }

    openCombobox();

    if (!open && selectedLabel) {
      const input = event.currentTarget;
      requestAnimationFrame(() => input.select());
    }
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    if (!open) {
      setOpen(true);
    }
    setHasTypedSinceOpen(true);
    setQuery(event.target.value);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (disabled) {
      return;
    }

    if (!open && event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      openCombobox();
      setHasTypedSinceOpen(true);
      setQuery(event.key);
      setActiveValue(null);
      return;
    }

    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      openCombobox();
      setActiveValue(
        event.key === "ArrowUp"
          ? options[options.length - 1]?.value ?? null
          : selectedOption?.value ?? options[0]?.value ?? null,
      );
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
      return;
    }

    if (event.key === "Home") {
      if (open) {
        event.preventDefault();
        setActiveValue(filteredOptions[0]?.value ?? null);
      }
      return;
    }

    if (event.key === "End") {
      if (open) {
        event.preventDefault();
        setActiveValue(filteredOptions[filteredOptions.length - 1]?.value ?? null);
      }
      return;
    }

    if (event.key === "Enter") {
      if (open && activeValue) {
        event.preventDefault();
        selectOption(activeValue);
      }
      return;
    }

    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        closeCombobox({ focus: true });
      }
    }
  }

  useEffect(() => {
    if (open) {
      return;
    }

    setQuery(selectedLabel);
    setHasTypedSinceOpen(false);
  }, [open, selectedLabel]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) {
        return;
      }
      closeCombobox();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open, selectedLabel]);

  useEffect(() => {
    if (!open) {
      return;
    }

    setActiveValue((current) => {
      if (current && filteredOptions.some((option) => option.value === current)) {
        return current;
      }
      if (selectedOption && filteredOptions.some((option) => option.value === selectedOption.value)) {
        return selectedOption.value;
      }
      return filteredOptions[0]?.value ?? null;
    });
  }, [filteredOptions, open, selectedOption]);

  useEffect(() => {
    if (!open || !activeValue) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      optionRefs.current[activeValue]?.scrollIntoView({ block: "nearest" });
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [activeValue, open]);

  return (
    <div
      ref={rootRef}
      className="relative"
      onBlurCapture={() => {
        if (!open) {
          return;
        }

        requestAnimationFrame(() => {
          const activeElement = document.activeElement;
          if (rootRef.current && activeElement instanceof Node && !rootRef.current.contains(activeElement)) {
            closeCombobox();
          }
        });
      }}
    >
      <div className="relative">
        <input
          ref={inputRef}
          type="search"
          value={inputValue}
          disabled={disabled}
          readOnly={!open}
          name={`${listboxId}-search`}
          autoComplete="new-password"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          data-form-type="other"
          data-lpignore="true"
          data-1p-ignore="true"
          placeholder={open ? searchPlaceholder : placeholder}
          aria-label={ariaLabel}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeDescendant}
          onFocus={handleInputFocus}
          onChange={handleInputChange}
          onClick={() => {
            if (!open) {
              openCombobox({ selectText: true });
            }
          }}
          onKeyDown={handleInputKeyDown}
          className={[
            denDropdownFieldBaseClass,
            "rounded-lg placeholder:text-gray-400",
            open ? denDropdownFieldOpenClass : "",
            disabled ? "cursor-not-allowed opacity-60" : "cursor-text",
            className ?? "",
          ]
            .filter(Boolean)
            .join(" ")}
        />
        <span className={denDropdownChevronSlotClass}>
          <ChevronDown size={16} className={disabled ? "text-gray-300" : "text-gray-400"} aria-hidden="true" />
        </span>
      </div>

      {open ? (
        <div className={denDropdownMenuBaseClass}>
          <div id={listboxId} role="listbox" className={denDropdownListClass}>
            {filteredOptions.length ? (
              filteredOptions.map((option, index) => {
                const selected = option.value === value;
                const active = option.value === activeValue;

                return (
                  <button
                    key={option.value}
                    ref={(node) => {
                      optionRefs.current[option.value] = node;
                    }}
                    id={`${listboxId}-option-${index}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    onMouseEnter={() => setActiveValue(option.value)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      selectOption(option.value);
                    }}
                    className={[
                      denDropdownRowBaseClass,
                      "items-start",
                      selected ? denDropdownRowSelectedClass : active ? denDropdownRowActiveClass : denDropdownRowIdleClass,
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium text-gray-900">{option.label}</p>
                      {option.description ? (
                        <p className="mt-1 truncate text-[12px] text-gray-500">{option.description}</p>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 items-center gap-3 pl-2">
                      {option.meta ? <span className="text-[12px] text-gray-400">{option.meta}</span> : null}
                      {selected ? <Check className="h-4 w-4 text-gray-900" aria-hidden="true" /> : null}
                    </div>
                  </button>
                );
              })
            ) : (
              <div className="px-3 py-4 text-[13px] text-gray-500">
                {query ? `${emptyLabel} "${query}"` : emptyLabel}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
