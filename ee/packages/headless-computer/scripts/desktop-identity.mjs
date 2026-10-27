import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * Files that reach the desktop image without passing through the guest bundle, plus the runner's half of the bridge
 * protocol. Paths are relative to the repository root; directories are read recursively.
 */
export const IMAGE_FILES = [
  "ee/packages/headless-computer/Dockerfile.desktop", "ee/packages/headless-computer/requirements-desktop.lock",
  "ee/packages/headless-computer/src/image.ts", "ee/packages/headless-computer/src/desktop.ts",
  "ee/packages/headless-computer/src/scripting",
  "ee/packages/headless-computer/scripts/build-desktop.mjs", "ee/packages/headless-computer/scripts/desktop-identity.mjs",
  "ee/packages/headless-computer/scripts/build-desktop-vnc.sh", "ee/packages/headless-computer/scripts/desktop-bridge.py",
  "ee/packages/headless-computer/scripts/vnc-stdio.py", "ee/packages/headless-computer/scripts/configure-desktop-files.sh",
  "ee/packages/headless-computer/scripts/install-desktop-apps.sh",
  "ee/packages/headless-computer/scripts/daytona-desktop-permissions.service",
  "ee/packages/headless-computer/scripts/daytona-desktop-permissions.conf",
  "ee/apps/den-worker-runtime/scripts/cloud-desktop.sh",
];

/**
 * Packages the guest's dependencies only try to load (TypeScript's source maps, ws's native helpers), each in a try
 * block with a fallback. esbuild would bundle them whenever the workspace happens to have them installed, so the guest,
 * and its identity, would depend on what else was installed. The guest never ships them.
 */
export const GUEST_OPTIONAL_PACKAGES = ["bufferutil", "source-map-support", "utf-8-validate"];

/**
 * The guest's compatibility identity: the bytes of every repository file esbuild bundled into the guest (from its
 * metafile), the name and version of every installed package it bundled, and the image files above. Anything the guest
 * doesn't contain, such as the rest of the lockfile, Mac-only code or tests, leaves the identity unchanged, so it no
 * longer forces a snapshot rebuild.
 */
export async function desktopIdentity({ root, workingDirectory, inputs }) {
  const sources = new Set();
  const packages = new Set();
  for (const input of inputs) {
    const path = relative(root, join(workingDirectory, input)).split(sep).join("/");
    const installed = path.lastIndexOf("node_modules/");
    if (installed === -1) { sources.add(path); continue; }
    const [first, second] = path.slice(installed + "node_modules/".length).split("/");
    const name = first.startsWith("@") ? `${first}/${second}` : first;
    const manifest = JSON.parse(await readFile(join(root, path.slice(0, installed), "node_modules", name, "package.json"), "utf8"));
    packages.add(`${name}@${manifest.version}`);
  }
  const fingerprint = createHash("sha256");
  async function include(path) {
    let bytes;
    try { bytes = await readFile(join(root, path)); }
    catch (error) { if (error.code === "ENOENT") return; if (error.code !== "EISDIR") throw error; }
    if (bytes) { fingerprint.update(path).update("\0").update(bytes).update("\0"); return; }
    for (const entry of (await readdir(join(root, path))).sort()) await include(`${path}/${entry}`);
  }
  for (const path of [...new Set([...sources, ...IMAGE_FILES])].sort()) await include(path);
  for (const name of [...packages].sort()) fingerprint.update(`package:${name}`).update("\0");
  return `${fingerprint.digest("hex")}\n`;
}
