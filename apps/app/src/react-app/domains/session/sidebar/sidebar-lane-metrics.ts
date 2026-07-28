/** Base inline-start padding (px) matching `SIDEBAR_ROW_LANE` / `ps-3`. */
export const SIDEBAR_ROW_BASE_PAD_PX = 12;

/** Nesting step (px) — one step per tree depth level. */
export const SIDEBAR_ROW_NEST_STEP_PX = 16;

/** Inline-start padding for a session (or group) row at the given tree depth. */
export function sidebarRowPaddingInlineStart(depth: number) {
  return SIDEBAR_ROW_BASE_PAD_PX + Math.max(0, depth) * SIDEBAR_ROW_NEST_STEP_PX;
}
