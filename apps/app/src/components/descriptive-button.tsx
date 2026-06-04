import type * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type DescriptiveButtonProps = React.ComponentProps<typeof Button> & {
  orientation?: "horizontal" | "vertical";
}

export function DescriptiveButton({ children, className, orientation = "horizontal", ...props }: DescriptiveButtonProps) {
  return (
    <Button
      variant="ghost"
      className={cn(
        "group/button border border-border hover:bg-muted/20 flex h-auto w-full min-w-0 max-w-full shrink items-start justify-start gap-3 px-4 py-3 text-left whitespace-normal",
        orientation === "vertical" && "flex-col",
        className,
      )}
      data-orientation={orientation}
      {...props}
    >
      {children}
    </Button>
  )
}

type DescriptiveButtonIconProps = React.ComponentProps<"div">

export function DescriptiveButtonIcon({ children, className, ...props }: DescriptiveButtonIconProps) {
  return (
    <div className={cn("text-accent-foreground flex size-8 shrink-0 items-center justify-center group-data-[orientation=vertical]/button:h-8 group-data-[orientation=vertical]/button:w-fit", className)} {...props}>
      {children}
    </div>
  )
}

type DescriptiveButtonTitleProps = React.ComponentProps<"span">

export function DescriptiveButtonTitle({ children, className, ...props }: DescriptiveButtonTitleProps) {
  return (
    <span className={cn("truncate", className)} {...props}>{children}</span>
  )
}

type DescriptiveButtonDescriptionProps = React.ComponentProps<"span">

export function DescriptiveButtonDescription({ children, className, ...props }: DescriptiveButtonDescriptionProps) {
  return (
    <span className={cn("text-muted-foreground block min-w-0 wrap-break-word text-sm font-normal", className)} {...props}>{children}</span>
  )
}

type DescriptiveButtonContentProps = React.ComponentProps<"div">

export function DescriptiveButtonContent({ children, className, ...props }: DescriptiveButtonContentProps) {
  return (
    <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5", className)} {...props}>{children}</div>
  )
}