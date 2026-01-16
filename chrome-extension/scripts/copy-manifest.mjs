// Post-build script to copy manifest and other static files to dist
import { copyFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");
const distDir = join(rootDir, "dist");

// Ensure dist directory exists
if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

// Copy manifest.json
const manifestSrc = join(rootDir, "manifest.json");
const manifestDest = join(distDir, "manifest.json");
copyFileSync(manifestSrc, manifestDest);
console.log("✓ Copied manifest.json");

// Copy sidepanel.html
const htmlSrc = join(rootDir, "public", "sidepanel.html");
const htmlDest = join(distDir, "sidepanel.html");
copyFileSync(htmlSrc, htmlDest);
console.log("✓ Copied sidepanel.html");

// Copy icons directory
const iconsDir = join(rootDir, "icons");
const iconsDistDir = join(distDir, "icons");
if (!existsSync(iconsDistDir)) {
  mkdirSync(iconsDistDir, { recursive: true });
}

if (existsSync(iconsDir)) {
  const icons = readdirSync(iconsDir);
  for (const icon of icons) {
    const src = join(iconsDir, icon);
    const dest = join(iconsDistDir, icon);
    copyFileSync(src, dest);
    console.log(`✓ Copied icons/${icon}`);
  }
}

console.log("\n✅ Chrome extension build complete!");
console.log("Load the 'dist' folder as an unpacked extension in Chrome.");
