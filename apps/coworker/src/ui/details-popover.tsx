import { useEffect, useRef, useState, type ReactNode } from "react";
import { workPopoverPlacement, type WorkPopoverPlacement } from "@/ui/work-popover";

/**
 * A line in the conversation that opens more detail *over* the transcript,
 * never inside it. Nothing that has landed in the conversation grows when the
 * person looks closer: a bubble keeps the height it landed with, and the detail
 * — thinking, a review's updates, the discussion an assignment carries — floats
 * in a light popover under (or over) its line, the same shell the receipt's
 * steps use. Escape, a click outside, or the line itself closes it.
 */
export function PopoverDisclosure({
  label,
  title,
  icon = null,
  testId,
  className = "",
  children,
}: {
  /** The line as it reads closed: "Thought through", "Reviewed 2 updates from Workers". */
  label: ReactNode;
  /** The popover's heading and accessible name. */
  title: string;
  icon?: ReactNode;
  testId: string;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<WorkPopoverPlacement>("below");
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);

  return (
    <div className={`relative ${className}`} data-testid={testId} data-open={open ? "true" : "false"}>
      <button
        ref={anchorRef}
        type="button"
        className="flex items-center gap-1.5 py-0.5 text-left hover:text-snow"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          if (!open && anchorRef.current) setPlacement(workPopoverPlacement(anchorRef.current.getBoundingClientRect(), window.innerHeight));
          setOpen((current) => !current);
        }}
      >
        {icon}
        <span>{label}</span>
        <span className={`text-mist/60 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true">›</span>
      </button>
      {open ? (
        <div
          ref={popoverRef}
          role="dialog"
          aria-modal="false"
          aria-label={title}
          className={`thinking-popover absolute left-0 z-40 w-[min(420px,calc(100vw-48px))] rounded-[14px] border border-line bg-panel text-left text-[11px] text-mist shadow-[0_12px_32px_rgba(0,0,0,0.35)] ${placement === "above" ? "bottom-full mb-1.5" : "top-full mt-1.5"}`}
          data-testid="coworker-details-popover"
          data-placement={placement}
        >
          <div className="px-3.5 pt-2.5 font-semibold text-snow">{title}</div>
          <div className="max-h-[min(320px,60vh)] overflow-y-auto px-3.5 pb-3 pt-1.5 leading-relaxed">{children}</div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Detail that is part of a bubble from the start — the raw reason behind a
 * failure — shown small and bounded so the bubble lands at its full height and
 * never grows. A long text scrolls inside its own few lines.
 */
export function TechnicalText({ text, testId }: { text: string; testId: string }) {
  return (
    <div className="mt-2 text-[11px] text-mist" data-testid={testId}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-mist/70">Technical details</p>
      <p className="mt-0.5 max-h-20 overflow-y-auto break-words font-mono leading-relaxed">{text}</p>
    </div>
  );
}
