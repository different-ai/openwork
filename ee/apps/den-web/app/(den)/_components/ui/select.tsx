"use client";

import { Check, ChevronDown, Search } from "lucide-react";
import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import {
  denDropdownChevronSlotClass,
  denDropdownFieldBaseClass,
  denDropdownFieldOpenClass,
  denDropdownListClass,
  denDropdownRowActiveClass,
  denDropdownRowBaseClass,
  denDropdownRowIdleClass,
  denDropdownRowSelectedClass,
} from "./dropdown-styles";
import { DenDropdownPopup, DenDropdownRoot, DenDropdownTrigger } from "./dropdown-popup";

type DenSelectOption = {
  value: string;
  disabled: boolean;
  content: ReactNode;
};

export type DenSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "disabled"> & {
  disabled?: boolean;
  /** Adds a filter field above long option lists. The trigger stays a button. */
  searchLabel?: string;
  searchEmptyLabel?: string;
};

function getOptionText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(getOptionText).join("");
  }

  if (isValidElement<{ children?: ReactNode }>(node)) {
    return getOptionText(node.props.children);
  }

  return "";
}

function createSelectEvent(value: string, name?: string) {
  return {
    target: { value, name: name ?? "" },
    currentTarget: { value, name: name ?? "" },
  } as ChangeEvent<HTMLSelectElement>;
}

function createBlurEvent(value: string, name?: string) {
  return {
    target: { value, name: name ?? "" },
    currentTarget: { value, name: name ?? "" },
  } as FocusEvent<HTMLSelectElement>;
}

function getFirstEnabledOption(options: DenSelectOption[]) {
  return options.find((option) => !option.disabled) ?? null;
}

export function DenSelect({
  value,
  defaultValue,
  name,
  id,
  disabled = false,
  className,
  children,
  onChange,
  onBlur,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  searchLabel,
  searchEmptyLabel = "No options match this search.",
}: DenSelectProps) {
  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const [uncontrolledValue, setUncontrolledValue] = useState<string | null>(defaultValue !== undefined ? String(defaultValue) : null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const optionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const listboxId = useId();

  const options = useMemo(() => {
    return Children.toArray(children).flatMap((child) => {
      if (!isValidElement(child) || child.type !== "option") {
        return [];
      }

      const option = child as ReactElement<{
        value?: string | number;
        disabled?: boolean;
        children?: ReactNode;
      }>;

      return [
        {
          value: option.props.value !== undefined ? String(option.props.value) : getOptionText(option.props.children),
          disabled: option.props.disabled === true,
          content: option.props.children,
        } satisfies DenSelectOption,
      ];
    });
  }, [children]);

  useEffect(() => {
    if (value === undefined && uncontrolledValue === null && options.length) {
      setUncontrolledValue(options[0]?.value ?? null);
    }
  }, [options, uncontrolledValue, value]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = useMemo(() => {
    if (!searchLabel || !normalizedQuery) return options;
    return options.filter((option) => `${getOptionText(option.content)} ${option.value}`.toLowerCase().includes(normalizedQuery));
  }, [normalizedQuery, options, searchLabel]);

  const selectedValue = value !== undefined ? String(value) : uncontrolledValue ?? "";
  const selectedOption = options.find((option) => option.value === selectedValue) ?? options[0] ?? null;

  function focusTrigger() {
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  }

  function openSelect(preferredValue?: string | null) {
    if (disabled) {
      return;
    }

    setOpen(true);
    setQuery("");
    const nextActive = options.find((option) => option.value === preferredValue && !option.disabled) ?? getFirstEnabledOption(options);
    setActiveValue(nextActive?.value ?? null);
  }

  function closeSelect({ focus = false }: { focus?: boolean } = {}) {
    setOpen(false);
    setActiveValue(null);
    setQuery("");
    if (focus) {
      focusTrigger();
    }
  }

  function commitValue(nextValue: string) {
    const nextOption = options.find((option) => option.value === nextValue);
    if (disabled || !nextOption || nextOption.disabled) {
      return;
    }

    if (value === undefined) {
      setUncontrolledValue(nextValue);
    }

    onChange?.(createSelectEvent(nextValue, name));
    closeSelect({ focus: true });
  }

  function moveActive(step: 1 | -1) {
    const enabledOptions = visibleOptions.filter((option) => !option.disabled);
    if (!enabledOptions.length) {
      return;
    }

    if (activeValue === null) {
      setActiveValue(step === 1 ? enabledOptions[0]?.value ?? null : enabledOptions[enabledOptions.length - 1]?.value ?? null);
      return;
    }

    const currentIndex = enabledOptions.findIndex((option) => option.value === activeValue);
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + step + enabledOptions.length) % enabledOptions.length;
    setActiveValue(enabledOptions[nextIndex]?.value ?? null);
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (activeValue !== null && visibleOptions.some((option) => option.value === activeValue)) {
        commitValue(activeValue);
      }
      return;
    }

    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const enabledOptions = visibleOptions.filter((option) => !option.disabled);
      setActiveValue((event.key === "Home" ? enabledOptions[0] : enabledOptions[enabledOptions.length - 1])?.value ?? null);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSelect({ focus: true });
    }
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        openSelect(selectedOption?.value ?? null);
        return;
      }
      moveActive(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openSelect(selectedOption?.value ?? options[options.length - 1]?.value ?? null);
        return;
      }
      moveActive(-1);
      return;
    }

    if (event.key === "Home" && open) {
      event.preventDefault();
      setActiveValue(getFirstEnabledOption(options)?.value ?? null);
      return;
    }

    if (event.key === "End" && open) {
      event.preventDefault();
      const enabledOptions = options.filter((option) => !option.disabled);
      setActiveValue(enabledOptions[enabledOptions.length - 1]?.value ?? null);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) {
        openSelect(selectedOption?.value ?? null);
        return;
      }

      if (activeValue !== null) {
        commitValue(activeValue);
      }
      return;
    }

    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      closeSelect({ focus: true });
    }
  }

  useEffect(() => {
    if (disabled) {
      setOpen(false);
      setActiveValue(null);
      setQuery("");
    }
  }, [disabled]);

  useEffect(() => {
    if (!open || activeValue === null) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      optionRefs.current[activeValue]?.scrollIntoView({ block: "nearest" });
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [activeValue, open]);

  const activeIndex = activeValue !== null ? visibleOptions.findIndex((option) => option.value === activeValue) : -1;
  const activeDescendant = activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined;

  return (
    <DenDropdownRoot
      open={open}
      onOpenChange={(nextOpen, details) => {
        if (nextOpen) {
          openSelect(selectedOption?.value ?? null);
        } else {
          closeSelect({ focus: details.reason === "escape-key" });
        }
      }}
    >
    <div
      ref={rootRef}
      className="relative"
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && (rootRef.current?.contains(nextTarget) || popupRef.current?.contains(nextTarget))) return;
        requestAnimationFrame(() => {
          const activeElement = document.activeElement;
          if (activeElement instanceof Node && !rootRef.current?.contains(activeElement) && !popupRef.current?.contains(activeElement)) {
            onBlur?.(createBlurEvent(selectedValue, name));
          }
        });
      }}
    >
      {name ? <input type="hidden" name={name} value={selectedValue} disabled={disabled} /> : null}

      <DenDropdownTrigger
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={searchLabel ? undefined : activeDescendant}
        onClick={(event) => {
          event.preventBaseUIHandler();
          if (open) {
            closeSelect();
            return;
          }
          openSelect(selectedOption?.value ?? null);
        }}
        onKeyDown={(event) => {
          event.preventBaseUIHandler();
          handleTriggerKeyDown(event);
        }}
        className={[
          denDropdownFieldBaseClass,
          "flex items-center justify-between gap-3 rounded-lg text-left",
          "focus-visible:border-gray-300 focus-visible:ring-2 focus-visible:ring-gray-900/5",
          open ? denDropdownFieldOpenClass : "",
          disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
          className ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <span className="truncate">{selectedOption?.content ?? null}</span>
        <span className={denDropdownChevronSlotClass}>
          <ChevronDown size={16} className={disabled ? "text-gray-300" : "text-gray-400"} aria-hidden="true" />
        </span>
      </DenDropdownTrigger>

      {open ? (
        <DenDropdownPopup anchor={triggerRef} popupRef={popupRef} initialFocus={searchLabel ? searchRef : false}>
          {searchLabel ? (
            <div className="relative shrink-0 border-b border-gray-200">
              <Search size={16} strokeWidth={1.5} className="pointer-events-none absolute inset-y-0 left-3 my-auto text-gray-400" aria-hidden="true" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                aria-label={searchLabel}
                placeholder={searchLabel}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={open}
                aria-controls={listboxId}
                aria-activedescendant={activeDescendant}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  const nextQuery = event.target.value;
                  setQuery(nextQuery);
                  const normalized = nextQuery.trim().toLowerCase();
                  const firstMatch = options.find((option) => !option.disabled
                    && (!normalized || `${getOptionText(option.content)} ${option.value}`.toLowerCase().includes(normalized)));
                  setActiveValue(firstMatch?.value ?? null);
                }}
                onKeyDown={handleSearchKeyDown}
                className="h-10 w-full bg-transparent pl-9 pr-3 text-[14px] text-gray-900 outline-hidden placeholder:text-gray-400 focus-visible:bg-gray-50"
              />
            </div>
          ) : null}
          {searchLabel && !visibleOptions.length ? (
            <div role="status" className="px-3 py-4 text-[13px] text-gray-500">{searchEmptyLabel}</div>
          ) : null}
          <div id={listboxId} role="listbox" className={denDropdownListClass}>
            {visibleOptions.map((option, index) => {
              const selected = option.value === selectedValue;
              const active = option.value === activeValue;

              return (
                <button
                  key={`${option.value}-${index}`}
                  ref={(node) => {
                    optionRefs.current[option.value] = node;
                  }}
                  id={`${listboxId}-option-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={selected}
                  disabled={option.disabled}
                  onPointerMove={(event) => {
                    if (event.pointerType !== "touch" && !option.disabled) {
                      setActiveValue(option.value);
                    }
                  }}
                  onPointerDown={(event) => {
                    // Keep active-descendant focus on the control for mouse/pen,
                    // but let touch gestures scroll before a click commits.
                    if (event.pointerType !== "touch") event.preventDefault();
                  }}
                  onClick={() => commitValue(option.value)}
                  className={[
                    denDropdownRowBaseClass,
                    "min-h-10 items-center",
                    option.disabled
                      ? "cursor-not-allowed opacity-50"
                      : selected
                        ? denDropdownRowSelectedClass
                        : active
                          ? denDropdownRowActiveClass
                          : denDropdownRowIdleClass,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <span className="line-clamp-2 min-w-0 flex-1 break-words whitespace-normal text-[14px] font-medium text-gray-900">
                    {option.content}
                  </span>
                  {selected ? <Check className="h-4 w-4 shrink-0 text-gray-900" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        </DenDropdownPopup>
      ) : null}
    </div>
    </DenDropdownRoot>
  );
}
