import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [target, ...args] = process.argv.slice(2);
if (!["desktop", "worktree", "electron", "ui"].includes(target)) {
  throw new Error("Usage: node scripts/dev.mjs <desktop|worktree|electron|ui> [args...]");
}

process.env.OPENWORK_DEV_MODE = "1";
if (target === "desktop") {
  process.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT ||= "9823";
}
if (target === "worktree") {
  process.env.OPENWORK_DEV_PROFILE = "auto";
  process.env.OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN ||= "1";
  process.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT = "0";
  process.env.PORT = "0";
}

const root = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = resolve(root, "apps", target === "ui" ? "app" : "desktop");
const require = createRequire(resolve(packageRoot, "package.json"));
const entry = target === "ui"
  ? resolve(dirname(require.resolve("vite/package.json")), "bin/vite.js")
  : resolve(packageRoot, "scripts/electron-dev.mjs");

process.chdir(packageRoot);
process.argv = [process.execPath, entry, ...args];
await import(pathToFileURL(entry).href);
