export const dmgLayout = {
  backgroundDirName: ".background",
  backgroundFileName: "bg.tiff",
  iconPosition: { x: 330, y: 180 },
  iconSize: 128,
  volumeName: "Install OpenWork",
  window: { left: 100, top: 100, width: 660, height: 400 },
}

export function dmgWindowBounds(window) {
  return [window.left, window.top, window.left + window.width, window.top + window.height]
}

export function dmgBackgroundPaths(root) {
  const backgroundDir = `${root}/${dmgLayout.backgroundDirName}`
  return {
    backgroundDir,
    tiff: `${backgroundDir}/${dmgLayout.backgroundFileName}`,
  }
}

export function buildTiffutilArgs(assetDir, outputPath) {
  return ["-cathidpicheck", `${assetDir}/bg.png`, `${assetDir}/bg@2x.png`, "-out", outputPath]
}

export function buildReadWriteDmgArgs({ sourceFolder, outputPath }) {
  return ["create", "-format", "UDRW", "-volname", dmgLayout.volumeName, "-srcfolder", sourceFolder, "-ov", outputPath]
}

export function buildCompressedDmgArgs({ inputPath, outputPath }) {
  return ["convert", inputPath, "-format", "UDZO", "-ov", "-o", outputPath]
}

export function appleScriptString(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

export function buildFinderLayoutScript({ appName, backgroundPath, mountPoint }) {
  const bounds = dmgWindowBounds(dmgLayout.window)
  const mountPointString = appleScriptString(mountPoint)
  const backgroundPathString = appleScriptString(backgroundPath)
  const appNameString = appleScriptString(appName)

  return `set dmgFolder to POSIX file "${mountPointString}" as alias
set backgroundFile to POSIX file "${backgroundPathString}" as alias
tell application "Finder"
  open dmgFolder
  delay 1
  set dmgWindow to container window of dmgFolder
  set toolbar visible of dmgWindow to false
  set statusbar visible of dmgWindow to false
  set current view of dmgWindow to icon view
  set bounds of dmgWindow to {${bounds.join(", ")}}
  set viewOptions to icon view options of dmgWindow
  set arrangement of viewOptions to not arranged
  set icon size of viewOptions to ${dmgLayout.iconSize}
  set label position of viewOptions to bottom
  set background picture of viewOptions to backgroundFile
  set position of item "${appNameString}" of dmgWindow to {${dmgLayout.iconPosition.x}, ${dmgLayout.iconPosition.y}}
  update dmgFolder without registering applications
  delay 1
  close dmgWindow
end tell`
}
