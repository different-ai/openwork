"use client"

import * as React from "react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { ChevronDown, Circle } from "lucide-react"

export type CollapsibleToolItemProps = React.ComponentProps<"div">

export const CollapsibleToolItem = ({
  children,
  className,
  ...props
}: CollapsibleToolItemProps) => (
  <div className={cn("text-muted-foreground text-sm", className)} {...props}>
    {children}
  </div>
)

export type CollapsibleToolTriggerProps = React.ComponentProps<
  typeof CollapsibleTrigger
> & {
  leftIcon?: React.ReactNode
  swapIconOnHover?: boolean
}

export const CollapsibleToolTrigger = ({
  children,
  className,
  leftIcon,
  swapIconOnHover = true,
  ...props
}: CollapsibleToolTriggerProps) => (
  <CollapsibleTrigger
    className={cn(
      "group text-muted-foreground hover:text-foreground flex w-full min-w-0 cursor-pointer items-center justify-start gap-1 overflow-hidden text-start text-sm transition-colors",
      className
    )}
    {...props}
  >
    <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
      {leftIcon ? (
        <span className="relative inline-flex size-4 items-center justify-center">
          <span
            className={cn(
              "transition-opacity",
              swapIconOnHover && "group-hover:opacity-0"
            )}
          >
            {leftIcon}
          </span>
          {swapIconOnHover && (
            <ChevronDown className="absolute size-4 opacity-0 transition-opacity group-hover:opacity-100 group-data-panel-open:rotate-180" />
          )}
        </span>
      ) : (
        <span className="relative inline-flex size-4 items-center justify-center">
          <Circle className="size-2 fill-current" />
        </span>
      )}
      <span className="min-w-0">{children}</span>
    </div>
    {!leftIcon && (
      <ChevronDown className="size-4 transition-transform group-data-panel-open:rotate-180" />
    )}
  </CollapsibleTrigger>
)

export type CollapsibleToolContentProps = React.ComponentProps<
  typeof CollapsibleContent
>

export const CollapsibleToolContent = ({
  children,
  className,
  ...props
}: CollapsibleToolContentProps) => {
  return (
    <CollapsibleContent
      className={cn(
        "text-popover-foreground h-(--collapsible-panel-height) overflow-hidden text-sm transition-[height] duration-150 ease-out data-starting-style:h-0 data-ending-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden",
        className
      )}
      {...props}
    >
      {children}
    </CollapsibleContent>
  )
}

export type CollapsibleToolProps = {
  children: React.ReactNode
  className?: string
}

export function CollapsibleTool({ children, className }: CollapsibleToolProps) {
  const childrenArray = React.Children.toArray(children)

  return (
    <div className={cn("space-y-0", className)}>
      {childrenArray.map((child, index) => (
        <React.Fragment key={index}>
          {React.isValidElement(child) &&
            React.cloneElement(
              child as React.ReactElement<CollapsibleToolStepProps>,
              {
                isLast: index === childrenArray.length - 1,
              }
            )}
        </React.Fragment>
      ))}
    </div>
  )
}

export type CollapsibleToolStepProps = {
  children: React.ReactNode
  className?: string
  isLast?: boolean
}

export const CollapsibleToolStep = ({
  children,
  className,
  isLast = false,
  ...props
}: CollapsibleToolStepProps & React.ComponentProps<typeof Collapsible>) => {
  return (
    <Collapsible
      className={cn("group", className)}
      data-last={isLast}
      {...props}
    >
      {children}
      <div className="flex justify-start group-data-[last=true]:hidden">
        <div className="bg-primary/20 ms-1.75 h-4 w-px" />
      </div>
    </Collapsible>
  )
}
