"use client";

import { Dialog as CommandDialogPrimitive } from "@base-ui/react/dialog";
import { SearchIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";
import {
  Autocomplete,
  AutocompleteCollection,
  AutocompleteEmpty,
  AutocompleteGroup,
  AutocompleteGroupLabel,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompleteSeparator,
} from "@/components/ui/autocomplete";

export const CommandDialog: typeof CommandDialogPrimitive.Root =
  CommandDialogPrimitive.Root;

export const CommandDialogPortal: typeof CommandDialogPrimitive.Portal =
  CommandDialogPrimitive.Portal;

export const CommandCreateHandle: typeof CommandDialogPrimitive.createHandle =
  CommandDialogPrimitive.createHandle;

export function CommandDialogTrigger(
  props: CommandDialogPrimitive.Trigger.Props,
): React.ReactElement {
  return (
    <CommandDialogPrimitive.Trigger
      data-slot="command-dialog-trigger"
      {...props}
    />
  );
}

export function CommandDialogBackdrop({
  className,
  ...props
}: CommandDialogPrimitive.Backdrop.Props): React.ReactElement {
  return (
    <CommandDialogPrimitive.Backdrop
      className={cn(
        "fixed inset-0 z-50 bg-black/32 transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      data-slot="command-dialog-backdrop"
      {...props}
    />
  );
}

export function CommandDialogViewport({
  className,
  ...props
}: CommandDialogPrimitive.Viewport.Props): React.ReactElement {
  return (
    <CommandDialogPrimitive.Viewport
      className={cn(
        "fixed inset-0 z-50 flex flex-col items-center px-4 py-[max(--spacing(4),4vh)] sm:py-[10vh]",
        className,
      )}
      data-slot="command-dialog-viewport"
      {...props}
    />
  );
}

export function CommandDialogPopup({
  className,
  children,
  portalProps,
  ...props
}: CommandDialogPrimitive.Popup.Props & {
  portalProps?: CommandDialogPrimitive.Portal.Props;
}): React.ReactElement {
  return (
    <CommandDialogPortal {...portalProps}>
      <CommandDialogBackdrop />
      <CommandDialogViewport>
        <CommandDialogPrimitive.Popup
          className={cn(
            "relative row-start-2 flex max-h-105 min-h-0 w-full min-w-0 max-w-xl -translate-y-[calc(1.25rem*var(--nested-dialogs))] scale-[calc(1-0.1*var(--nested-dialogs))] flex-col rounded-2xl border bg-popover not-dark:bg-clip-padding text-popover-foreground opacity-[calc(1-0.1*var(--nested-dialogs))] shadow-lg/5 outline-none transition-[scale,opacity,translate] duration-200 ease-in-out will-change-transform before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:bg-muted/20 before:shadow-[0_1px_--theme(--color-black/4%)] data-nested:data-ending-style:translate-y-8 data-nested:data-starting-style:translate-y-8 data-nested-dialog-open:origin-top data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 **:data-[slot=scroll-area-viewport]:data-has-overflow-y:pe-0.5 dark:before:shadow-[0_-1px_--theme(--color-white/6%)] backdrop-blur-xl",
            className,
          )}
          data-slot="command-dialog-popup"
          {...props}
        >
          {children}
        </CommandDialogPrimitive.Popup>
      </CommandDialogViewport>
    </CommandDialogPortal>
  );
}

export function Command({
  autoHighlight = "always",
  keepHighlight = true,
  ...props
}: React.ComponentProps<typeof Autocomplete>): React.ReactElement {
  return (
    <Autocomplete
      autoHighlight={autoHighlight}
      inline
      keepHighlight={keepHighlight}
      open
      {...props}
    />
  );
}

export function CommandInput({
  className,
  placeholder = undefined,
  ...props
}: React.ComponentProps<typeof AutocompleteInput>): React.ReactElement {
  return (
    <AutocompleteInput
      autoFocus
      className={cn(
        "border-transparent! bg-transparent! shadow-none before:hidden focus-visible:ring-0! has-focus-visible:ring-0!",
        className,
      )}
      placeholder={placeholder}
      startAddon={<SearchIcon />}
      {...props}
    />
  );
}

export function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteList>): React.ReactElement {
  return (
    <AutocompleteList
      className={cn("not-empty:scroll-py-2 not-empty:p-2", className)}
      data-slot="command-list"
      {...props}
    />
  );
}

export function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteEmpty>): React.ReactElement {
  return (
    <AutocompleteEmpty
      className={cn("not-empty:py-6", className)}
      data-slot="command-empty"
      {...props}
    />
  );
}

export function CommandPanel({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn(
        "relative min-h-0",
        className,
      )}
      {...props}
    />
  );
}

export function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteGroup>): React.ReactElement {
  return (
    <AutocompleteGroup
      className={className}
      data-slot="command-group"
      {...props}
    />
  );
}

export function CommandGroupLabel({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteGroupLabel>): React.ReactElement {
  return (
    <AutocompleteGroupLabel
      className={className}
      data-slot="command-group-label"
      {...props}
    />
  );
}

export function CommandCollection({
  ...props
}: React.ComponentProps<typeof AutocompleteCollection>): React.ReactElement {
  return <AutocompleteCollection data-slot="command-collection" {...props} />;
}

export function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteItem>): React.ReactElement {
  return (
    <AutocompleteItem
      className={cn(
        "py-1.5 data-highlighted:bg-foreground/5",
        className,
      )}
      data-slot="command-item"
      {...props}
    />
  );
}

export function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteSeparator>): React.ReactElement {
  return (
    <AutocompleteSeparator
      className={cn("my-2", className)}
      data-slot="command-separator"
      {...props}
    />
  );
}

export function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"kbd">): React.ReactElement {
  return (
    <kbd
      className={cn(
        "ms-auto font-medium font-sans text-muted-foreground/72 text-xs tracking-widest",
        className,
      )}
      data-slot="command-shortcut"
      {...props}
    />
  );
}

export function CommandFooter({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 rounded-b-[calc(var(--radius-2xl)-1px)] border-t border-foreground/10 dark:border-border px-5 py-3 text-muted-foreground text-xs",
        className,
      )}
      data-slot="command-footer"
      {...props}
    />
  );
}

export function CommandDialogTitle({ className, ...props }: React.ComponentProps<typeof CommandDialogPrimitive.Title>) {
  return (
    <CommandDialogPrimitive.Title
      className={cn("sr-only", className)}
      {...props}
    />
  );
}

export function CommandHeader({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn("p-2", className)}
      data-slot="command-header"
      {...props}
    />
  );
}

export { CommandDialogPrimitive };
