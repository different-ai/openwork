"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** Close a popover on outside pointer or Escape. */
export function useDismiss(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  return ref;
}

export type MenuItem = { id: string; label: string; hint?: string; selected?: boolean };

type DemoMenuProps = {
  label: string;
  trigger: ReactNode;
  items: MenuItem[];
  onSelect: (id: string) => void;
  triggerClassName: string;
  /** Open above the trigger (composer) or below it (toolbars). */
  placement?: "top" | "bottom";
  align?: "start" | "end";
  title?: string;
};

/** Small menu for the product previews. Button + list, closes on pick, outside click or Escape. */
export function DemoMenu({ label, trigger, items, onSelect, triggerClassName, placement = "top", align = "start", title }: DemoMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((current) => !current)}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open ? (
        <div
          role="menu"
          className={`absolute z-20 min-w-[220px] rounded-xl bg-white p-1.5 shadow-[0_0_0_1px_rgba(1,22,39,0.08),0_12px_32px_-8px_rgba(1,22,39,0.2)] ${
            placement === "top" ? "bottom-full mb-2" : "top-full mt-2"
          } ${align === "end" ? "right-0" : "left-0"}`}
        >
          {title ? <div className="px-2.5 pb-1 pt-1.5 text-[11px] text-[#6B7280]">{title}</div> : null}
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.selected ?? false}
              onClick={() => {
                onSelect(item.id);
                setOpen(false);
              }}
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-[#111827] hover:bg-[#F3F4F6] focus-visible:bg-[#F3F4F6] focus-visible:outline-none"
            >
              <span className="flex-1">{item.label}</span>
              {item.hint ? <span className="text-[11px] text-[#8A93A0]">{item.hint}</span> : null}
              {item.selected ? <span className="text-xs text-[var(--lp-ink)]" aria-hidden="true">✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--lp-ink)]";
