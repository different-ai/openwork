import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

export function Button({
  variant = "default",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger" }) {
  const styles = {
    default: "border border-white/10 bg-white/6 text-snow hover:bg-white/10 hover:border-white/16",
    primary: "border border-spark/35 bg-spark/16 text-[#adc3ff] hover:bg-spark/24",
    ghost: "border border-transparent text-mist hover:bg-white/6 hover:text-snow hover:border-white/8",
    danger: "border border-rose/35 bg-rose/10 text-rose hover:bg-rose/18",
  } as const;
  const busy = props["aria-busy"] === true || props["aria-busy"] === "true";
  return (
    <button
      {...props}
      className={`rounded-xl px-3 py-1.5 text-sm font-medium transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]} ${className}`}
    >
      {busy ? <span className="button-busy-indicator" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-panel">
      <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="text-sm font-semibold tracking-wide text-snow">{title}</h2>
        <div className="flex items-center gap-2">{actions}</div>
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-mist">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  "w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-snow placeholder:text-mist/60 focus:border-spark/50 focus:bg-white/7 focus:outline-none";

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-mist">{children}</p>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-rose/30 bg-rose/10 px-3 py-2 text-sm text-rose">{children}</p>;
}

export function StatusDot({ tone }: { tone: "spark" | "mint" | "amber" | "rose" | "mist" }) {
  const colors = { spark: "bg-spark", mint: "bg-mint", amber: "bg-amber", rose: "bg-rose", mist: "bg-mist" } as const;
  return <span className={`inline-block size-2 rounded-full ${colors[tone]}`} />;
}

/** The app's sliders glyph, shared by every settings control. 16×16 by default. */
export function SlidersIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 4.25h10M5.5 8h5M4.5 11.75h7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="6" cy="4.25" r="1.25" fill="currentColor" />
      <circle cx="9" cy="8" r="1.25" fill="currentColor" />
      <circle cx="7" cy="11.75" r="1.25" fill="currentColor" />
    </svg>
  );
}

/**
 * A 32×32 icon-only control. `label` is both the accessible name and the
 * tooltip, so the icon never needs a visible word beside it.
 */
export function IconButton({
  label,
  className = "",
  children,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title" | "children"> & { label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      {...props}
      aria-label={label}
      title={label}
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-mist transition-colors hover:bg-white/6 hover:text-snow focus-visible:bg-white/6 focus-visible:text-snow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

export type ActionMenuItem = {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Destructive items render in rose. */
  tone?: "default" | "danger";
};

/** A compact "⋯" menu for one row's secondary actions. Closes on outside click and Escape. */
export function ActionMenu({ label, items }: { label: string; items: ActionMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target instanceof Node ? event.target : null)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <IconButton
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="size-7 rounded-md text-base leading-none"
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">⋯</span>
      </IconButton>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className="absolute right-0 top-full z-40 mt-1 min-w-36 overflow-hidden rounded-xl border border-line bg-[#0d121b] py-1 text-left"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={`block w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-white/6 disabled:cursor-not-allowed disabled:opacity-40 ${
                item.tone === "danger" ? "text-rose" : "text-snow"
              }`}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
