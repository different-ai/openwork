// This PC as a Computer Use placement on Windows. The bundled helper
// (packages/computer-use/windows/ComputerUse.cs, shipped as
// helpers/openwork-computer-use.exe) lists windows, captures the selected one
// and sends input; the shared runtime adds sessions, receipts, Take over,
// Continue, Stop and watch frames. It needs no system permissions and does not
// depend on the remoteComputers rollout. Main process only.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRemoteComputerAdapter } from "@openwork/computer-use/computer-remote";
import { createWindowsDriver } from "@openwork/computer-use/computer-windows-driver";

const defaultAppRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperName = "openwork-computer-use.exe";

/**
 * @param {{
 *   resourcesPath?: string,
 *   appRoot?: string,
 *   fileExists?: (candidate: string) => boolean,
 *   spawnChild?: typeof import("node:child_process").spawn,
 * }} [options]
 */
export function createWindowsComputerAdapter({ resourcesPath = process.resourcesPath, appRoot = defaultAppRoot, fileExists = existsSync, spawnChild } = {}) {
  const binary = () => [
    process.env.OPENWORK_COMPUTER_USE_BINARY?.trim() || null,
    resourcesPath ? path.join(resourcesPath, "helpers", helperName) : null,
    path.join(appRoot, "resources", "helpers", helperName),
  ].find((candidate) => candidate && fileExists(candidate)) ?? null;
  return createRemoteComputerAdapter({
    id: "this-pc",
    label: "This PC",
    placement: "local",
    driver: createWindowsDriver({ binary, ...(spawnChild ? { spawnChild } : {}) }),
  });
}
