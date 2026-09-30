// On Windows and Linux the title bar is hidden and Electron draws only the
// native caption buttons over the renderer. Left unset, their colors fall back
// to the system default (light on Windows), which leaves a light block beside a
// dark title bar. These mirror the renderer's header tokens: --dls-surface
// (--slate-1) behind the buttons and --dls-text-primary (--slate-12) for the
// glyphs, from apps/app/src/styles/colors.css.
const LIGHT = { color: "#fcfcfd", symbolColor: "#1c2024" };
const DARK = { color: "#111113", symbolColor: "#edeef0" };

// Matches --window-titlebar-height in apps/app/src/app/index.css.
const TITLEBAR_HEIGHT = 40;

/**
 * @param {{ shouldUseDarkColors: boolean }} theme Electron's nativeTheme.
 * @returns {{ color: string, symbolColor: string, height: number }}
 */
export function titleBarOverlayForTheme(theme) {
  return { ...(theme.shouldUseDarkColors ? DARK : LIGHT), height: TITLEBAR_HEIGHT };
}
