/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export type SelectMenuOption = {
  value: string;
  label: string;
};

type SelectMenuProps = {
  options: SelectMenuOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  ariaLabelledBy?: string;
  ariaLabel?: string;
};

const triggerClass =
  "flex w-full items-center justify-between gap-2 rounded-xl border border-dls-border bg-dls-surface px-3.5 py-2.5 text-left text-[14px] text-dls-text shadow-none transition-[border-color,box-shadow] hover:border-dls-border focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.14)] disabled:cursor-not-allowed disabled:opacity-60";

const panelClass =
  "absolute left-0 right-0 top-[calc(100%+6px)] z-[100] max-h-56 overflow-auto rounded-xl border border-dls-border bg-dls-surface py-1 shadow-[var(--dls-shell-shadow)]";

const optionRowClass =
  "flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] text-dls-text transition-colors hover:bg-dls-hover";

export function SelectMenu(props: SelectMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const displayLabel = useMemo(() => {
    const match = props.options.find((o) => o.value === props.value);
    if (match) return match.label;
    return props.placeholder?.trim() || "";
  }, [props.options, props.placeholder, props.value]);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (rootRef.current && target && !rootRef.current.contains(target)) {
        close();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      window.removeEventListener("pointerdown", onPointerDown, true);
  }, [close, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, open]);

  return (
    <div ref={rootRef} className="relative w-full">
      <button
        type="button"
        id={props.id}
        className={triggerClass}
        disabled={props.disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-labelledby={props.ariaLabelledBy}
        aria-label={props.ariaLabel}
        onClick={() => {
          if (props.disabled) return;
          setOpen((o) => !o);
        }}
      >
        <span className="min-w-0 flex-1 truncate">{displayLabel}</span>
        <ChevronDown
          size={18}
          className={`shrink-0 text-dls-secondary transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
          aria-hidden
        />
      </button>

      {open && !props.disabled ? (
        <div className={panelClass} role="listbox">
          {props.options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === props.value}
              className={`${optionRowClass} ${
                opt.value === props.value ? "bg-dls-hover/80" : ""
              }`}
              onClick={() => {
                props.onChange(opt.value);
                close();
              }}
            >
              <span className="min-w-0 flex-1 truncate">{opt.label}</span>
              {opt.value === props.value ? (
                <Check
                  size={16}
                  className="shrink-0 text-[var(--dls-accent)]"
                  aria-hidden
                />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
