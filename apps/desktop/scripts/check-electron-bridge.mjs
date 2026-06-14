import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "../..");

const desktopBridgePath = resolve(repoRoot, "apps/app/src/app/lib/desktop.ts");
const electronMainPath = resolve(desktopRoot, "electron/main.mjs");

const desktopBridgeSource = readFileSync(desktopBridgePath, "utf8");
const electronMainSource = readFileSync(electronMainPath, "utf8");

const destructure = desktopBridgeSource.match(/const\s*\{([\s\S]*?)\}\s*=\s*desktopBridge;/);
if (!destructure?.[1]) {
  throw new Error(`Could not find desktopBridge export destructure in ${desktopBridgePath}`);
}

const clientOnlyBridgeMethods = new Set([
  // Pure helper implemented in apps/app/src/app/lib/desktop-tauri.ts and
  // intentionally satisfied inside the renderer proxy, not over Electron IPC.
  "resolveWorkspaceListSelectedId",
]);

const bridgeMethods = destructure[1]
  .split(/\r?\n/)
  .map((line) => line.replace(/\/\/.*$/, "").trim().replace(/,$/, ""))
  .filter(Boolean)
  .filter((name) => !clientOnlyBridgeMethods.has(name));

const electronHandlers = new Set(
  // Registry entries look like `"workspaceCreate": async (event, ...args) =>`.
  Array.from(electronMainSource.matchAll(/^  "([^"]+)": async \(event/gm)).map((match) => match[1]),
);

const missing = bridgeMethods.filter((name) => !electronHandlers.has(name));
if (missing.length > 0) {
  console.error("Electron desktop bridge is missing IPC handlers:");
  for (const name of missing) console.error(`- ${name}`);
  process.exit(1);
}

console.log(`Electron desktop bridge covers ${bridgeMethods.length} renderer methods.`);
