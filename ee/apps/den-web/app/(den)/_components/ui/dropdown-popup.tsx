"use client";

import { Popover } from "@base-ui/react/popover";
import type { ReactNode, RefObject } from "react";
import { denDropdownMenuBaseClass } from "./dropdown-styles";

export const DenDropdownRoot = Popover.Root;
export const DenDropdownTrigger = Popover.Trigger;

export type DenDropdownWidth = "content" | "trigger";

const positionerWidthClass: Record<DenDropdownWidth, string> = {
  content: "w-max min-w-[min(max(var(--anchor-width),20rem),var(--available-width))] max-w-[min(28rem,var(--available-width))]",
  trigger: "w-[var(--anchor-width)] max-w-[var(--available-width)]",
};

export function DenDropdownPopup({
  anchor,
  popupRef,
  initialFocus = false,
  width = "content",
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  popupRef: RefObject<HTMLDivElement | null>;
  initialFocus?: false | RefObject<HTMLElement | null>;
  width?: DenDropdownWidth;
  children: ReactNode;
}) {
  return (
    <Popover.Portal>
      <Popover.Positioner
        anchor={anchor}
        positionMethod="fixed"
        side="bottom"
        align="start"
        sideOffset={6}
        collisionBoundary={[]}
        collisionPadding={8}
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        className={`z-50 ${positionerWidthClass[width]}`}
      >
        <Popover.Popup
          ref={popupRef}
          initialFocus={initialFocus}
          finalFocus={false}
          role="presentation"
          data-den-dropdown-popup=""
          className={denDropdownMenuBaseClass}
        >
          {children}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  );
}
