import * as React from "react";
import { X } from "lucide-react";
import { Reorder } from "motion/react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type PanelTabListProps<Value> = Omit<
  React.ComponentProps<typeof Reorder.Group<Value, "div">>,
  "as" | "axis" | "onReorder" | "values"
> & {
  onReorder: (newOrder: Value[]) => void;
  values: Value[];
};

function PanelTabList<Value>({ className, ...props }: PanelTabListProps<Value>) {
  return (
    <Reorder.Group<Value, "div">
      as="div"
      axis="x"
      className={cn("flex min-w-max items-center gap-1", className)}
      {...props}
    />
  );
}

function PanelTabItem({ className, ...props }: React.ComponentProps<typeof Reorder.Item>) {
  return (
    <Reorder.Item
      as="div"
      layout="position"
      dragElastic={0}
      dragListener={false}
      className={cn("group relative w-36 min-w-0 shrink-0", className)}
      {...props}
    />
  );
}

type PanelTabProps = Omit<React.ComponentProps<typeof Button>, "size" | "variant"> & {
  active?: boolean;
};

function PanelTab({ active, className, ...props }: PanelTabProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "w-full min-w-0 justify-start gap-2 px-2 pr-8 text-left text-sm font-normal text-muted-foreground hover:bg-muted hover:text-foreground",
        active && "bg-muted/80 text-foreground",
        className,
      )}
      {...props}
    />
  );
}

type PanelTabCloseProps = Omit<React.ComponentProps<typeof Button>, "children" | "size" | "title" | "variant"> & {
  active?: boolean;
  label: string;
  onClose: () => void;
};

function PanelTabClose({
  active,
  className,
  label,
  onClick,
  onClose,
  onPointerDown,
  ...props
}: PanelTabCloseProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className={cn(
        "absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100",
        active && "text-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
      title="Close tab"
      aria-label={`Close tab: ${label}`}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(event);

        if (!event.defaultPrevented) {
          onClose();
        }
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown?.(event);
      }}
      {...props}
    >
      <X />
    </Button>
  );
}

export { PanelTabList, PanelTabItem, PanelTab, PanelTabClose };
