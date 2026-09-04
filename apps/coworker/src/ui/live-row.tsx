import { useEffect, useRef, useState } from "react";
import type { CoworkerSummary } from "@/lib/bridge";
import { thinkingAvailability, type LivePhase } from "@/lib/live-phase";
import type { LiveStream } from "@/lib/live-stream";
import type { WorkStep } from "@/lib/work-receipt";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { ToolIcon } from "@/ui/kit";
import { ThinkingPopover, type ThinkingPopoverMode } from "@/ui/thinking-popover";

/**
 * The live turn, the way someone typing reads in Messages. While the coworker
 * thinks: its avatar and a small typing bubble — three dots rising and falling
 * in turn — and no words. While a tool runs: the avatar and a chip with the
 * tool glyph and the step in plain words ("Reading launch-plan.md"). Tapping
 * the bubble or the chip opens a light popover with the thinking as it
 * arrives, or the step and its technical details. Past the wait budget the row
 * keeps its shape and gains the soft phrase and Stop. When the reply's words
 * start, the row is not shown at all: the bubble is.
 */
export type LiveRowCall = { tool: string; input: Record<string, unknown>; output?: unknown; error?: string | null };

export function LiveRow({
  coworker,
  phase,
  step,
  stepCall,
  stepSince,
  stream,
  reply,
  wordsArrived,
  sentAt,
  stillWorking = "",
  onStop,
}: {
  coworker: CoworkerSummary;
  phase: LivePhase;
  /** The tool step under way, when the phase is a tool. */
  step: WorkStep | null;
  stepCall: LiveRowCall | null;
  /** When the current step started, for the popover's small print. */
  stepSince: number | null;
  stream: LiveStream | null;
  /** The reply being written, as far as the transcript has it. */
  reply: { text: string; reasoning: string } | null;
  /** Words of the reply have arrived this turn (so a model that shared no thinking is known not to). */
  wordsArrived: boolean;
  /** When the person pressed Send, for "thinking for 4 s". */
  sentAt: number | null;
  /** The softened phrase once the wait budget has passed; empty while the phase alone speaks. */
  stillWorking?: string;
  onStop?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const thinking = stream && stream.type === "reasoning" && stream.text.trim() ? stream.text : reply?.reasoning ?? "";
  const availability = thinkingAvailability({ stream, reply, wordsArrived });

  // Words starting, or the turn ending, closes what was open.
  useEffect(() => {
    if (phase === "writing" || phase === "sending" || phase === "retrying") setOpen(false);
  }, [phase]);

  const mode: ThinkingPopoverMode = phase === "tool" && step && stepCall
    ? { kind: "doing", step, call: stepCall, since: stepSince }
    : { kind: "thinking", text: thinking, availability, since: sentAt };
  const doingWords = step ? `${step.doing.charAt(0).toUpperCase()}${step.doing.slice(1)}` : "";

  // While the words are arriving the bubble is the live view: the row shows nothing — unless the
  // words have stalled past the wait budget, when the soft phrase and Stop still need a place.
  if (phase === "writing" && !stillWorking) return null;

  return (
    <div className="px-1 py-1.5 text-xs text-mist" data-testid="coworker-working" data-phase={phase} data-outcome={stillWorking ? "slow" : "working"} data-popover={open ? "open" : "closed"}>
      <div ref={anchorRef} className="flex items-center gap-2.5">
        <CoworkerAvatar animated working={phase === "tool"} color={coworker.avatarColor} glasses={coworker.avatarGlasses} name={coworker.name} size={22} />
        {phase === "writing" ? null : phase === "tool" && step ? (
          <button
            type="button"
            className="flex h-6 max-w-[36ch] items-center gap-1.5 rounded-xl bg-panel-2 px-2.5 text-[12px] text-mist transition-colors hover:text-snow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50"
            title={open ? "Hide" : `See what ${coworker.name} is doing`}
            aria-label={`${coworker.name} is ${step.doing}. See the details`}
            aria-expanded={open}
            aria-haspopup="dialog"
            data-testid="coworker-tool-chip"
            onClick={() => setOpen((value) => !value)}
          >
            <ToolIcon className="size-3 shrink-0 motion-safe:animate-pulse" />
            <span className="truncate">{doingWords}</span>
          </button>
        ) : (
          <button
            type="button"
            className="typing-bubble bubble bubble-coworker flex h-[22px] w-[34px] items-center justify-center !px-0 !py-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50"
            title={open ? "Hide" : `See what ${coworker.name} is thinking`}
            aria-label={`${coworker.name} is thinking. See the thinking`}
            aria-expanded={open}
            aria-haspopup="dialog"
            data-testid="coworker-typing"
            onClick={() => setOpen((value) => !value)}
          >
            <span className="flex items-center gap-[3px]" aria-hidden="true">
              {[0, 1, 2].map((index) => (
                <span key={index} className="typing-dot size-[5px] rounded-full bg-mist/80" style={{ animationDelay: `${index * 160}ms` }} />
              ))}
            </span>
          </button>
        )}
        {stillWorking ? (
          <span className="flex items-center gap-x-3 text-[12px] text-mist" data-testid="coworker-still-working">
            <span>{stillWorking}</span>
            {onStop ? (
              <button type="button" className="font-medium text-snow/80 underline-offset-2 hover:underline" data-testid="coworker-turn-choice" data-choice="stop" onClick={onStop}>
                Stop
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      {open ? <ThinkingPopover coworkerName={coworker.name} mode={mode} anchor={anchorRef.current} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
