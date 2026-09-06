import { release } from "node:os";

/** Native materials stay behind the chrome; text never inherits window opacity. */
export function windowMaterial(theme, platform = process.platform, systemVersion = release()) {
  if (theme.prefersReducedTransparency || theme.shouldUseHighContrastColors || theme.inForcedColorsMode || theme.shouldUseInvertedColorScheme) return "none";
  if (platform === "darwin") return "vibrancy";
  const [major, , build] = systemVersion.split(".").map(Number);
  if (platform === "win32" && major >= 10 && build >= 22621) return "mica";
  return "none";
}

export function bindWindowAppearance(window, theme, platform = process.platform, systemVersion = release()) {
  let material = "none";
  const publish = () => {
    window.webContents.send("coworker:appearance", { material, focused: window.isFocused() });
  };
  const update = () => {
    material = windowMaterial(theme, platform, systemVersion);
    if (platform === "darwin") window.setVibrancy(material === "vibrancy" ? "under-window" : null);
    if (platform === "win32") window.setBackgroundMaterial(material === "mica" ? "mica" : "none");
    window.setBackgroundColor(material === "none" ? "#090c12" : "#00000000");
    publish();
  };
  update();
  theme.on("updated", update);
  window.on("focus", publish);
  window.on("blur", publish);
  window.webContents.on("did-finish-load", publish);
  window.once("closed", () => {
    theme.removeListener("updated", update);
    window.removeListener("focus", publish);
    window.removeListener("blur", publish);
    window.webContents.removeListener("did-finish-load", publish);
  });
}
