"use client";

import { Popover } from "@base-ui/react/popover";
import type { ReactNode, RefObject } from "react";
import { denDropdownMenuBaseClass } from "./dropdown-styles";

// Keep the Select/Combobox value and keyboard contracts while sharing Base UI's
// portal, anchor tracking, collision handling and dismissal/focus containment.
export const DenDropdownRoot = Popover.Root;
export const DenDropdownTrigger = Popover.Trigger;

export function DenDropdownPopup({
  anchor,
  popupRef,
  initialFocus = false,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  popupRef: RefObject<HTMLDivElement | null>;
  initialFocus?: false | RefObject<HTMLElement | null>;
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
        // Options can be wider than the compact selected-value control. Bound both
        // the readable minimum and content width so collision handling still fits
        // the whole menu on narrow screens (including anchors wider than the viewport).
        className="z-50 w-max min-w-[min(max(var(--anchor-width),20rem),var(--available-width))] max-w-[min(28rem,var(--available-width))]"
      >
        <Popover.Popup
          ref={popupRef}
          initialFocus={initialFocus}
          // Commit/Escape restore the control; outside presses and Tab must keep
          // focus on the person's next target instead of pulling it back.
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
