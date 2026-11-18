import type { RefObject } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type FindFieldProps = {
  inputRef: RefObject<HTMLInputElement | null>;
  /** Names the field: its placeholder and accessible name. */
  label: string;
  query: string;
  onQueryChange: (query: string) => void;
  /** "2/7", "No matches", or empty while the query is too short. */
  counterText: string;
  hasMatches: boolean;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
};

/**
 * The find control shared by "Find in conversation" and "Find on this page":
 * a field, a match counter, and previous / next / close. Enter moves to the
 * next match, Shift+Enter to the previous one, Escape closes.
 */
export function FindField(props: FindFieldProps) {
  return (
    <div className="flex items-center gap-1 rounded-xl border border-dls-border bg-dls-surface/95 px-1.5 py-1 shadow-(--dls-card-shadow) backdrop-blur-md">
      <Search className="ml-1 size-3.5 shrink-0 text-dls-secondary" />
      <input
        ref={props.inputRef}
        value={props.query}
        onChange={(event) => props.onQueryChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) {
              props.onPrevious();
            } else {
              props.onNext();
            }
            return;
          }

          if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
          }
        }}
        className="h-7 w-48 bg-transparent px-1 text-sm text-dls-text outline-none placeholder:text-dls-secondary sm:h-8 sm:w-56"
        placeholder={props.label}
        aria-label={props.label}
      />
      <span className={cn(
        "min-w-14 text-right text-xs tabular-nums text-muted-foreground",
        props.counterText === "No matches" && "min-w-20",
      )} aria-live="polite">
        {props.counterText}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Previous match"
              disabled={!props.hasMatches}
              onMouseDown={(event) => event.preventDefault()}
              onClick={props.onPrevious}
            >
              <ChevronUp />
            </Button>
          }
        />
        <TooltipContent>Previous match (⇧↵)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Next match"
              disabled={!props.hasMatches}
              onMouseDown={(event) => event.preventDefault()}
              onClick={props.onNext}
            >
              <ChevronDown />
            </Button>
          }
        />
        <TooltipContent>Next match (↵)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Close find"
              onMouseDown={(event) => event.preventDefault()}
              onClick={props.onClose}
            >
              <X />
            </Button>
          }
        />
        <TooltipContent>Close (Esc)</TooltipContent>
      </Tooltip>
    </div>
  );
}
