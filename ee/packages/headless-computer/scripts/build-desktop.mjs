import { build } from "esbuild";
import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

await build({
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  entryPoints: ["src/desktop-guest.mjs"], outfile: "dist/desktop-guest.mjs", bundle: true,
  platform: "node", format: "esm", target: "node22",
  // TypeScript's bundled CommonJS runtime also resolves its own file location.
  // The guest is a standalone ESM file with no installed node_modules.
  banner: { js: "import { createRequire } from 'node:module'; import { fileURLToPath as guestFileURLToPath } from 'node:url'; import { dirname as guestDirname } from 'node:path'; const require = createRequire(import.meta.url); const __filename = guestFileURLToPath(import.meta.url); const __dirname = guestDirname(__filename);" },
});
await copyFile(new URL("../../../apps/den-worker-runtime/scripts/cloud-desktop.sh", import.meta.url), new URL("../dist/cloud-desktop.sh", import.meta.url));
