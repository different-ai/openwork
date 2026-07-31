// Host-owned surface placement.
//
// The app declares a preset — "a small island on the right" — and a size it
// would like. The host decides where that actually goes. This split matters:
// an app that could set its own bounds could park an always-on-top window over
// the menu bar, off the visible area, or across a display boundary, and the
// user would have no way to get at it.
//
// Pure and total, so every awkward display arrangement is testable: a small
// laptop screen, a display whose origin is negative, a surface larger than the
// work area, an anchor near a rounded corner.

/** Minimum breathing room between a surface and the edge of the work area. */
const EDGE_MARGIN = 16

/** Never let a surface exceed this fraction of the work area in either axis. */
const MAX_FRACTION = 0.8

export const SURFACE_ANCHORS = Object.freeze([
  "right-center",
  "right-top",
  "right-bottom",
  "left-center",
  "top-center",
  "bottom-center",
])

/**
 * Compute the bounds for a floating surface.
 *
 * `workArea` is the display's usable rectangle, already excluding the menu bar
 * and dock. Its `x`/`y` may be negative on a secondary display to the left of
 * the primary one, which is why every calculation is relative to it rather than
 * to the origin.
 */
export function resolveSurfaceBounds(requested, workArea, anchor = "right-center") {
  const maxWidth = Math.floor(workArea.width * MAX_FRACTION)
  const maxHeight = Math.floor(workArea.height * MAX_FRACTION)

  const width = clamp(Math.round(requested.width), 120, Math.max(120, maxWidth))
  const height = clamp(Math.round(requested.height), 80, Math.max(80, maxHeight))

  const left = workArea.x + EDGE_MARGIN
  const right = workArea.x + workArea.width - width - EDGE_MARGIN
  const top = workArea.y + EDGE_MARGIN
  const bottom = workArea.y + workArea.height - height - EDGE_MARGIN
  const centreX = workArea.x + Math.round((workArea.width - width) / 2)
  const centreY = workArea.y + Math.round((workArea.height - height) / 2)

  let x
  let y
  switch (anchor) {
    case "right-top":
      x = right
      y = top
      break
    case "right-bottom":
      x = right
      y = bottom
      break
    case "left-center":
      x = left
      y = centreY
      break
    case "top-center":
      x = centreX
      y = top
      break
    case "bottom-center":
      x = centreX
      y = bottom
      break
    case "right-center":
    default:
      x = right
      y = centreY
      break
  }

  // On a work area too small for the margins, centring beats clinging to an
  // edge that no longer exists.
  return {
    width,
    height,
    x: clamp(x, workArea.x, Math.max(workArea.x, workArea.x + workArea.width - width)),
    y: clamp(y, workArea.y, Math.max(workArea.y, workArea.y + workArea.height - height)),
  }
}

/** True when the rectangle sits entirely inside the work area. */
export function isFullyVisible(bounds, workArea) {
  return (
    bounds.x >= workArea.x &&
    bounds.y >= workArea.y &&
    bounds.x + bounds.width <= workArea.x + workArea.width &&
    bounds.y + bounds.height <= workArea.y + workArea.height
  )
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value))
}

/**
 * Window options for an app surface.
 *
 * Every security-relevant flag is set here rather than left to a default,
 * because a default that changes in a future Electron release must not silently
 * loosen an app sandbox. `sandbox`, `contextIsolation`, and `nodeIntegration`
 * are the three that matter most; the rest close narrower holes.
 */
export function surfaceWindowOptions({ appId, bounds, alwaysOnTop, preloadPath, partition }) {
  return {
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: alwaysOnTop === true,
    // A floating app surface must not steal focus from whatever the user is
    // typing into. This is what keeps an ambient surface ambient.
    focusable: true,
    acceptFirstMouse: false,
    title: appId,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      enableBlinkFeatures: "",
      spellcheck: false,
      // A dedicated partition per app: no shared cookies, cache, storage, or
      // service workers between two installed apps, or with OpenWork itself.
      partition,
      preload: preloadPath,
    },
  }
}
