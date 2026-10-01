/** @jsxImportSource react */
import type { ReactNode, RefObject } from "react";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Suggestions for what is being typed in the composer (`/` commands and `@`
 * mentions). The list floats above the composer through the shared Popover, so
 * it flips below when there is no room above and the chat surface can never
 * clip it. Focus stays in the editor, which owns the arrow keys and Enter.
 */
export function ComposerSuggestionMenu(props: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  children: ReactNode;
}) {
  return (
    <Popover
      open={props.open}
      onOpenChange={(open, details) => {
        if (open) return;
        // Moving the caret inside the draft is not leaving it: the editor's
        // query decides when the list goes away. Any other press closes it.
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
        // Pressing the list or its scrollbar must not move the caret out of the editor.
        onMouseDown={(event) => event.preventDefault()}
        className="max-h-[min(var(--available-height),16rem)] w-(--anchor-width) gap-0 overscroll-contain rounded-[14px] bg-popover p-1.5 shadow-[var(--dls-shell-shadow)] ring-0 data-open:animate-none data-closed:animate-none dark:ring-0"
      >
        {props.children}
      </PopoverContent>
    </Popover>
  );
}

/** One suggestion row: an icon, a title and an optional one-line description. */
export function composerSuggestionRowClass(highlighted: boolean) {
  return cn(
    "flex w-full min-w-0 items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
    highlighted ? "bg-gray-3 text-gray-12" : "text-gray-11 hover:bg-gray-2/70",
  );
}
