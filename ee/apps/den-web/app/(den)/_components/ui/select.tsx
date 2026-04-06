"use client";

import { Check, ChevronDown } from "lucide-react";
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
  denDropdownMenuBaseClass,
  denDropdownRowActiveClass,
  denDropdownRowBaseClass,
  denDropdownRowIdleClass,
  denDropdownRowSelectedClass,
} from "./dropdown-styles";

type DenSelectOption = {
  value: string;
  disabled: boolean;
  content: ReactNode;
};

export type DenSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "disabled"> & {
  disabled?: boolean;
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
}: DenSelectProps) {
  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const [uncontrolledValue, setUncontrolledValue] = useState<string | null>(defaultValue !== undefined ? String(defaultValue) : null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
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

  const selectedValue = value !== undefined ? String(value) : uncontrolledValue ?? "";
  const selectedOption = options.find((option) => option.value === selectedValue) ?? options[0] ?? null;

  function focusTrigger() {
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function openSelect(preferredValue?: string | null) {
    if (disabled) {
      return;
    }

    setOpen(true);
    const nextActive = options.find((option) => option.value === preferredValue && !option.disabled) ?? getFirstEnabledOption(options);
    setActiveValue(nextActive?.value ?? null);
  }

  function closeSelect({ focus = false }: { focus?: boolean } = {}) {
    setOpen(false);
    setActiveValue(null);
    if (focus) {
      focusTrigger();
    }
  }

  function commitValue(nextValue: string) {
    const nextOption = options.find((option) => option.value === nextValue);
    if (!nextOption || nextOption.disabled) {
      return;
    }

    if (value === undefined) {
      setUncontrolledValue(nextValue);
    }

    onChange?.(createSelectEvent(nextValue, name));
    closeSelect({ focus: true });
  }

  function moveActive(step: 1 | -1) {
    const enabledOptions = options.filter((option) => !option.disabled);
    if (!enabledOptions.length) {
      return;
    }

    if (!activeValue) {
      setActiveValue(step === 1 ? enabledOptions[0]?.value ?? null : enabledOptions[enabledOptions.length - 1]?.value ?? null);
      return;
    }

    const currentIndex = enabledOptions.findIndex((option) => option.value === activeValue);
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + step + enabledOptions.length) % enabledOptions.length;
    setActiveValue(enabledOptions[nextIndex]?.value ?? null);
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

      if (activeValue) {
        commitValue(activeValue);
      }
      return;
    }

    if (event.key === "Escape" && open) {
      event.preventDefault();
      closeSelect({ focus: true });
    }
  }

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) {
        return;
      }
      closeSelect();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open]);

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

  const activeIndex = activeValue ? options.findIndex((option) => option.value === activeValue) : -1;
  const activeDescendant = activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined;

  return (
    <div
      ref={rootRef}
      className="relative"
      onBlurCapture={() => {
        requestAnimationFrame(() => {
          const activeElement = document.activeElement;
          if (rootRef.current && activeElement instanceof Node && !rootRef.current.contains(activeElement)) {
            if (open) {
              closeSelect();
            }
            onBlur?.(createBlurEvent(selectedValue, name));
          }
        });
      }}
    >
      {name ? <input type="hidden" name={name} value={selectedValue} disabled={disabled} /> : null}

      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeDescendant}
        onClick={() => {
          if (open) {
            closeSelect();
            return;
          }
          openSelect(selectedOption?.value ?? null);
        }}
        onKeyDown={handleTriggerKeyDown}
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
      </button>

      {open ? (
        <div className={denDropdownMenuBaseClass}>
          <div id={listboxId} role="listbox" className={denDropdownListClass}>
            {options.map((option, index) => {
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
                  onMouseEnter={() => {
                    if (!option.disabled) {
                      setActiveValue(option.value);
                    }
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    if (!option.disabled) {
                      commitValue(option.value);
                    }
                  }}
                  className={[
                    denDropdownRowBaseClass,
                    "items-center",
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
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-gray-900">
                    {option.content}
                  </span>
                  {selected ? <Check className="h-4 w-4 shrink-0 text-gray-900" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
