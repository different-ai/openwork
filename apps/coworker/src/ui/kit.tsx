import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { TOOLTIP_DELAY_MS, tooltipPosition, type TooltipSide } from "@/lib/tooltip";

export type { TooltipSide };

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

/** A thought bubble for reasoning receipts; pulses gently while the coworker is still thinking. */
export function ThoughtIcon({ className = "size-4", active = false }: { className?: string; active?: boolean }) {
  return (
    <svg className={`${className} ${active ? "animate-pulse" : ""}`} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M6.6 4.3a3.4 3.4 0 0 1 6.5.6 2.9 2.9 0 0 1 2.7 4.3 2.6 2.6 0 0 1-1.6 4.4H7.3a3 3 0 0 1-1.7-5.5 2.7 2.7 0 0 1 1-3.8Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="5.2" cy="16.2" r="1" fill="currentColor" />
      <circle cx="3.2" cy="18.3" r="0.7" fill="currentColor" />
    </svg>
  );
}

/** A small wrench for tool receipts. */
export function ToolIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M13.8 3.3a3.6 3.6 0 0 0-3.9 5l-6 6a1.4 1.4 0 0 0 2 2l6-6a3.6 3.6 0 0 0 5-3.9l-2.2 2.2-2.1-.5-.5-2.1 2.2-2.2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** An alert glyph for problems that need a person. */
export function AlertIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 6.2v4.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="10" cy="13.6" r="0.9" fill="currentColor" />
    </svg>
  );
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

/** A gentle pulse line: the coworker's current and recent activity. */
export function ActivityIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.75 8.25h2.4l1.9-4.5 2.6 8.5 2.2-6 1.35 2h1.85" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Four tiles: Apps & tools. */
export function AppsIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.25" />
      <rect x="9" y="2" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.25" />
      <rect x="2" y="9" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.25" />
      <path d="M11.5 9.25v4.5M9.25 11.5h4.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

/** One coworker fanning out to two: its Workers. */
export function WorkersIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="3.75" cy="8" r="1.75" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="12.25" cy="4" r="1.75" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="12.25" cy="12" r="1.75" stroke="currentColor" strokeWidth="1.25" />
      <path d="M5.4 7.25 10.6 4.75M5.4 8.75l5.2 2.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

/** A notebook: the Markdown memory the coworker keeps. */
export function MemoryIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 2.75h7.25a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H3.5V2.75Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M3.5 2.75v12M6.25 6h3.5M6.25 8.75h3.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

/** A chevron pointing the way a panel will move. */
export function ChevronIcon({ direction, className = "size-4" }: { direction: "left" | "right"; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={direction === "left" ? "M10 3.5 5.5 8l4.5 4.5" : "M6 3.5 10.5 8 6 12.5"} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A magnifier for finding a coworker. */
export function SearchIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.4" />
      <path d="m10.25 10.25 3.25 3.25" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** A plus for adding a coworker. */
export function PlusIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

type TriggerProps = {
  onMouseEnter?: (event: ReactMouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: ReactMouseEvent<HTMLElement>) => void;
  onFocus?: (event: ReactFocusEvent<HTMLElement>) => void;
  onBlur?: (event: ReactFocusEvent<HTMLElement>) => void;
  onClick?: (event: ReactMouseEvent<HTMLElement>) => void;
  "aria-describedby"?: string;
};

/**
 * One tooltip for the whole app: a short delay, placed on the chosen side of
 * its trigger, rendered at the document root so no panel's overflow clips it,
 * and named to assistive tech through `aria-describedby`. The child is the
 * trigger and must be one element that takes pointer and focus handlers.
 * Nothing shows when `content` is empty.
 */
export function Tooltip({
  content,
  side = "top",
  children,
}: {
  content: string;
  side?: TooltipSide;
  children: ReactElement<TriggerProps>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef(0);

  const clearTimer = () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = 0;
  };
  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, []);
  const showSoon = (target: HTMLElement) => {
    triggerRef.current = target;
    clearTimer();
    timerRef.current = window.setTimeout(() => setOpen(true), TOOLTIP_DELAY_MS);
  };

  useEffect(() => () => clearTimer(), []);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hide, open]);
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const trigger = triggerRef.current?.getBoundingClientRect();
    const tip = tipRef.current?.getBoundingClientRect();
    if (!trigger || !tip) return;
    setPosition(tooltipPosition(trigger, tip, side, { width: window.innerWidth, height: window.innerHeight }));
  }, [open, side, content]);

  const child = Children.only(children);
  if (!isValidElement<TriggerProps>(child)) return child;
  if (!content) return child;
  const trigger = cloneElement(child, {
    onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => {
      child.props.onMouseEnter?.(event);
      showSoon(event.currentTarget);
    },
    onMouseLeave: (event: ReactMouseEvent<HTMLElement>) => {
      child.props.onMouseLeave?.(event);
      hide();
    },
    onFocus: (event: ReactFocusEvent<HTMLElement>) => {
      child.props.onFocus?.(event);
      showSoon(event.currentTarget);
    },
    onBlur: (event: ReactFocusEvent<HTMLElement>) => {
      child.props.onBlur?.(event);
      hide();
    },
    onClick: (event: ReactMouseEvent<HTMLElement>) => {
      child.props.onClick?.(event);
      hide();
    },
    "aria-describedby": open ? [child.props["aria-describedby"], id].filter(Boolean).join(" ") : child.props["aria-describedby"],
  });
  return (
    <>
      {trigger}
      {open
        ? createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            data-testid="tooltip"
            data-side={side}
            className="pointer-events-none fixed z-[70] max-w-[260px] rounded-lg border border-line bg-[#0d121b] px-2.5 py-1.5 text-[11px] leading-snug text-snow shadow-[0_8px_24px_rgb(0_0_0/0.45)]"
            style={position ? { top: position.top, left: position.left } : { top: 0, left: 0, visibility: "hidden" }}
          >
            {content}
          </div>,
          document.body,
        )
        : null}
    </>
  );
}

/**
 * A 32×32 icon-only control. `label` is the accessible name; `tooltip` is what
 * a person sees on hover — the name by default, or a line that says what the
 * control shows. There is no native `title`.
 */
export function IconButton({
  label,
  tooltip,
  tooltipSide = "top",
  className = "",
  children,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title" | "children"> & {
  label: string;
  /** Hover copy; `false` for none. Defaults to the label. */
  tooltip?: string | false;
  tooltipSide?: TooltipSide;
  children: ReactNode;
}) {
  const button = (
    <button
      type="button"
      {...props}
      aria-label={label}
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-mist transition-colors hover:bg-white/6 hover:text-snow focus-visible:bg-white/6 focus-visible:text-snow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
  if (tooltip === false) return button;
  return <Tooltip content={tooltip ?? label} side={tooltipSide}>{button}</Tooltip>;
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
