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

/**
 * Sidebar lane system — two vertical rails shared by every row in the sidebar.
 *
 *   8px   row pill edge (SidebarGroup `p-2`)
 *   20px  glyph lane  — activity dot-matrix, chevrons, row icons, section labels
 *   44px  label lane  — every row title (glyph lane + 16px glyph + 8px `gap-2`)
 *
 * Rules:
 * 1. A row's first child is a `SidebarGlyphSlot`, rendered even when it has no
 *    glyph, so the title never shifts when an indicator appears.
 * 2. Section labels sit on the glyph lane, one step left of the titles below.
 * 3. Nesting steps right by 16px per depth level.
 */

/** Row padding that puts the glyph slot on the glyph lane. */
export const SIDEBAR_ROW_LANE = "ps-3";

/** One 12px nesting step right of `SIDEBAR_ROW_LANE`. */
export const SIDEBAR_ROW_LANE_NESTED = "ps-6";

/** Glyph lane for direct children of the sidebar content, which have no row edge. */
export const SIDEBAR_SECTION_LANE = "pl-5";

export const SIDEBAR_SECTION_LABEL =
  "text-[12px] font-normal uppercase tracking-[0.04em] text-muted-foreground";

const GLYPH_SLOT = "flex size-4 shrink-0 items-center justify-center";

/** The 16px glyph lane of a sidebar row. Always render it, empty or not. */
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
