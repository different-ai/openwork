// macOS charges Screen Recording to the outermost app around a process, even
// one that disclaimed responsibility. Run from inside OpenWork.app, the helper's
// grant would land on OpenWork and System Settings would offer to restart it.
// A packaged app therefore runs an exact copy of its helper from outside its
// own bundle. The copy lives in a folder this user can write, so it only runs
// while it matches the helper sealed inside the signed app.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const helperName = "OpenWork Computer Use.app";

const digest = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

/**
 * Returns the executable to run. The hash of a signed helper's executable also
 * covers its Info.plist and resources, which its code signature seals.
 * @param {string} binary The helper executable that was found.
 * @param {{ helpersRoot: string, directory: string, exec?: (file: string, args: string[]) => Promise<unknown> }} options
 * @returns {Promise<string>}
 */
export async function installComputerHelper(binary, { helpersRoot, directory, exec = run }) {
  const bundled = path.join(helpersRoot, helperName);
  // A development helper or OPENWORK_COMPUTER_USE_BINARY is not inside an app.
  if (!binary.startsWith(`${bundled}${path.sep}`)) return binary;
  const installed = path.join(directory, helperName);
  const target = path.join(installed, path.relative(bundled, binary));
  const expected = await digest(binary);
  if (await digest(target).catch(() => null) === expected) return target;

  // Staged beside the destination, so a failed copy never replaces a working one.
  const staging = path.join(directory, `.install-${randomUUID()}`);
  const staged = path.join(staging, helperName);
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 });
    // ditto keeps the signature; --noqtn drops the download's quarantine flag.
    await exec("/usr/bin/ditto", ["--noqtn", bundled, staged]);
    if (await digest(path.join(staged, path.relative(bundled, binary))) !== expected) {
      throw new Error("The Computer Use helper did not copy correctly.");
    }
    await rm(installed, { recursive: true, force: true });
    await rename(staged, installed);
    return target;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
