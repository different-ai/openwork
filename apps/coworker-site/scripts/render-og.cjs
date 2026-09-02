/**
 * Render public/og.png (1200x630) from scripts/og-card.html with Electron's
 * own compositor, so the share image uses the same geometry and palettes as
 * the app's brand mark and avatars. Run with:
 *   pnpm --filter @openwork/coworker-site og:render
 */
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const path = require("node:path");

const WIDTH = 1200;
const HEIGHT = 630;

app.commandLine.appendSwitch("force-device-scale-factor", "1");

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: "#090c12",
    webPreferences: { contextIsolation: true, offscreen: true },
  });
  await window.loadFile(path.join(__dirname, "og-card.html"));
  // Give fonts one frame to settle before capturing.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const captured = await window.webContents.capturePage({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
  // Retina displays capture at 2x; normalize to the exact share-card size.
  const image = captured.getSize().width === WIDTH ? captured : captured.resize({ width: WIDTH, height: HEIGHT, quality: "best" });
  const target = path.join(__dirname, "..", "public", "og.png");
  writeFileSync(target, image.toPNG());
  const size = image.getSize();
  console.log(`wrote ${target} (${size.width}x${size.height})`);
  app.exit(0);
});
