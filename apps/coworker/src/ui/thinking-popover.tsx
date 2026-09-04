import { useEffect, useRef, useState } from "react";
import { sinceMoment } from "@/lib/live-phase";
import { technicalSections, type WorkStep } from "@/lib/work-receipt";
import { ThoughtIcon, ToolIcon } from "@/ui/kit";

/**
 * What the coworker is doing right now, for a person who tapped the live row:
 * the thinking as it arrives (pinned to the newest line unless they scrolled
 * up), or the tool step and its technical details. A light popover anchored
 * under the row — never modal, never a card in the transcript. Escape, a click
 * outside, the reply's words starting, or the turn ending closes it.
 */
export type ThinkingPopoverMode =
  | { kind: "thinking"; text: string; availability: "available" | "not-yet" | "none"; since: number | null }
  | { kind: "doing"; step: WorkStep; call: { tool: string; input: Record<string, unknown>; output?: unknown; error?: string | null }; since: number | null };

const SCROLL_PIN_SLACK_PX = 24;

export function ThinkingPopover({
  coworkerName,
  mode,
  anchor,
  onClose,
}: {
  coworkerName: string;
  mode: ThinkingPopoverMode;
  /** The row element the popover hangs under; the popover's left edge lines up with it. */
  anchor: HTMLElement | null;
  onClose: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  // The small print counts seconds while the popover is open.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  // New words keep the newest line in view, unless the person scrolled up to read.
  const text = mode.kind === "thinking" ? mode.text : "";
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !pinned) return;
    body.scrollTop = body.scrollHeight;
  }, [pinned, text]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [anchor, onClose]);

  const since = mode.since === null ? "" : sinceMoment(mode.since, now);
  const smallPrint = mode.kind === "thinking" ? (since ? `thinking for ${since}` : "") : since ? `on this step for ${since}` : "";
  const title = mode.kind === "thinking" ? "Thinking" : "Doing";
  const emptyLine = mode.kind === "thinking" && !mode.text.trim()
    ? mode.availability === "none"
      ? "This AI model doesn't share its thinking."
      : `${coworkerName} hasn't started thinking out loud yet.`
    : "";
  const sections = mode.kind === "doing" ? technicalSections(mode.call) : [];

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="false"
      aria-label={`${coworkerName} is ${mode.kind === "thinking" ? "thinking" : "working"}`}
      className="thinking-popover mt-2 w-[360px] max-w-[76%] rounded-[14px] border border-line bg-panel shadow-[0_12px_32px_rgba(0,0,0,0.35)]"
      data-testid="coworker-thinking-popover"
      data-mode={mode.kind}
      data-pinned={pinned ? "true" : "false"}
    >
      <div className="flex items-center gap-2 px-3.5 pt-2.5 text-[11px]">
        {mode.kind === "thinking" ? <ThoughtIcon className="size-3.5 shrink-0 text-mist" active={mode.availability !== "none"} /> : <ToolIcon className="size-3.5 shrink-0 text-mist motion-safe:animate-pulse" />}
        <span className="font-semibold text-snow" aria-live="polite">{title}</span>
        {smallPrint ? <span className="ml-auto text-mist/80" data-testid="coworker-thinking-small-print">{smallPrint}</span> : null}
      </div>
      <div
        ref={bodyRef}
        className="max-h-[240px] overflow-y-auto px-3.5 pb-3 pt-1.5 text-[12px] leading-relaxed text-mist"
        aria-live="off"
        data-testid="coworker-thinking-text"
        onScroll={(event) => {
          const body = event.currentTarget;
          setPinned(body.scrollHeight - body.scrollTop - body.clientHeight <= SCROLL_PIN_SLACK_PX);
        }}
      >
        {mode.kind === "thinking" ? (
          mode.text.trim() ? <p className="whitespace-pre-wrap">{mode.text}</p> : <p className="text-mist/70">{emptyLine}</p>
        ) : (
          <>
            <p className="text-snow/85">{mode.step.doing.charAt(0).toUpperCase() + mode.step.doing.slice(1)}…</p>
            <details className="group/tech mt-2 text-[10px] text-mist/75" data-testid="coworker-thinking-technical">
              <summary className="flex cursor-pointer select-none items-center gap-1 hover:text-mist">
                <span className="text-mist/60 transition-transform group-open/tech:rotate-90" aria-hidden="true">›</span>
                Technical details
              </summary>
              <dl className="mt-1.5 space-y-1.5 rounded-lg bg-ink/70 p-2.5">
                <div className="flex items-baseline gap-2">
                  <dt className="w-14 shrink-0 text-mist/60">Tool</dt>
                  <dd className="min-w-0 break-all font-mono text-mist">{mode.call.tool}</dd>
                </div>
                {sections.map((section) => (
                  <div key={section.label} className="flex items-baseline gap-2">
                    <dt className={`w-14 shrink-0 ${section.label === "Error" ? "text-rose/80" : "text-mist/60"}`}>{section.label}</dt>
                    <dd className="min-w-0 flex-1">
                      <pre className={`max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono leading-relaxed ${section.label === "Error" ? "text-rose" : "text-snow/85"}`}>{section.text}</pre>
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
