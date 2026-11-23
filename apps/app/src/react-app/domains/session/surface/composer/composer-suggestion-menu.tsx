/** @jsxImportSource react */
import type { ReactNode, RefObject } from "react";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export function ComposerSuggestionMenu(props: {
  open: boolean;
  quiet?: boolean;
  anchor: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  children: ReactNode;
}) {
  return (
    <Popover
      open={props.open}
      onOpenChange={(open, details) => {
        if (open) return;
        const target = details.event?.target;
        if (details.reason === "outside-press" && target instanceof Element
          && target.closest("[contenteditable='true']") && props.anchor.current?.contains(target)) {
          details.cancel();
          return;
        }
        props.onDismiss();
      }}
    >
      <PopoverContent
        anchor={props.anchor}
        side="top"
        align="start"
        sideOffset={8}
        initialFocus={false}
        finalFocus={false}
        data-composer-suggestions=""
        onMouseDown={(event) => event.preventDefault()}
        className={cn(
          "max-h-[min(var(--available-height),16rem)] w-(--anchor-width) gap-0 overscroll-contain rounded-[14px] bg-popover p-1.5 ring-0 data-open:animate-none data-closed:animate-none dark:ring-0",
          props.quiet ? "border border-border shadow-none" : "shadow-[var(--dls-shell-shadow)]",
        )}
      >
        {props.children}
      </PopoverContent>
    </Popover>
  );
}

export function composerSuggestionRowClass(highlighted: boolean) {
  return cn(
    "flex w-full min-w-0 items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
    highlighted ? "bg-gray-3 text-gray-12" : "text-gray-11 hover:bg-gray-2/70",
  );
}
