import { build } from "esbuild";
import { copyFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { desktopIdentity, GUEST_OPTIONAL_PACKAGES } from "./desktop-identity.mjs";

const guest = await build({
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  entryPoints: ["src/desktop-guest.mjs"], outfile: "dist/desktop-guest.mjs", bundle: true,
  platform: "node", format: "esm", target: "node22", metafile: true, external: GUEST_OPTIONAL_PACKAGES,
  // TypeScript's bundled CommonJS runtime also resolves its own file location.
  // The guest is a standalone ESM file with no installed node_modules.
  banner: { js: "import { createRequire } from 'node:module'; import { fileURLToPath as guestFileURLToPath } from 'node:url'; import { dirname as guestDirname } from 'node:path'; const require = createRequire(import.meta.url); const __filename = guestFileURLToPath(import.meta.url); const __dirname = guestDirname(__filename);" },
});
await copyFile(new URL("../../../apps/den-worker-runtime/scripts/cloud-desktop.sh", import.meta.url), new URL("../dist/cloud-desktop.sh", import.meta.url));

// Compatibility follows what the guest bundles and the image installs, not the rest of the lockfile or code the guest
// never loads (see desktop-identity.mjs).
const identity = await desktopIdentity({
  root: fileURLToPath(new URL("../../../../", import.meta.url)),
  workingDirectory: fileURLToPath(new URL("..", import.meta.url)),
  inputs: Object.keys(guest.metafile.inputs),
});
await writeFile(new URL("../dist/desktop-guest.version", import.meta.url), identity);
// Keep the same identity in bundled Workers, which have no package asset files.
await writeFile(new URL("../dist/desktop-identity.mjs", import.meta.url), `export default ${JSON.stringify(identity)};\n`);
