// macOS dock icon reset for cleared organization brand icons.
//
// Packaged macOS builds ship the application icon only inside the .app bundle
// (electron-builder `mac.icon`), so unlike dev/Linux/Windows there is no loose
// image file on disk to re-apply when an organization clears its brand icon.
// Electron's dock.setIcon treats `null` as "restore the bundle icon from
// Info.plist" (browser_mac.mm handles IsNull() explicitly), which is exactly
// the stock icon we want back.
export function resetMacDockIcon(dock, defaultImage) {
  if (!dock) return { ok: false, reason: "dock-unavailable" };
  const image = defaultImage && !defaultImage.isEmpty() ? defaultImage : null;
  dock.setIcon(image);
  return { ok: true };
}
