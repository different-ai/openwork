import * as React from "react";

import { cn } from "@/lib/utils";
import {
  SIDEBAR_ROW_BASE_PAD_PX,
  SIDEBAR_ROW_NEST_STEP_PX,
  sidebarRowPaddingInlineStart,
} from "./sidebar-lane-metrics";

export {
  SIDEBAR_ROW_BASE_PAD_PX,
  SIDEBAR_ROW_NEST_STEP_PX,
  sidebarRowPaddingInlineStart,
};

export const SIDEBAR_ROW_LANE = "ps-3";

export const SIDEBAR_SECTION_LANE = "mx-2 ps-2.5 pe-2";

export const SIDEBAR_SECTION_LABEL =
  "text-[11px] font-light text-muted-foreground";

const GLYPH_SLOT = "flex size-4 shrink-0 items-center justify-center";

export function SidebarGlyphSlot({ children, className }: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <span aria-hidden={children ? undefined : "true"} className={cn(GLYPH_SLOT, className)}>
      {children}
    </span>
  );
}
