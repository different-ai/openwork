export const SIDEBAR_ROW_BASE_PAD_PX = 12;

export const SIDEBAR_ROW_NEST_STEP_PX = 16;

export function sidebarRowPaddingInlineStart(depth: number) {
  return SIDEBAR_ROW_BASE_PAD_PX + Math.max(0, depth) * SIDEBAR_ROW_NEST_STEP_PX;
}
