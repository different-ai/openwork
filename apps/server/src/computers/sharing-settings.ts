import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { insideSharedFolder } from "@openwork/computers";
import { computerSharingSettingsSchema, DEFAULT_COMPUTER_SHARING_SETTINGS, type ComputerSharingSettings } from "@openwork/types/computer-sharing";
import { computerFolderSchema } from "@openwork/types/den/computers";
import { protectedMountPaths, resolveSandboxMounts, SandboxFolderError, SandboxProtectedMountError } from "../sandbox-mounts.js";
import type { ServerConfig } from "../types.js";
import { createWorkspaceKvStore } from "../workspace-kv-store.js";

const install = "__install__";
const store = createWorkspaceKvStore({
  tableName: "runtime_computer_sharing", valueColumn: "settings_json",
  parse: (json): ComputerSharingSettings => computerSharingSettingsSchema.parse(JSON.parse(json)), serialize: (value) => JSON.stringify(value),
});
export class ComputerSharingSettingsError extends Error {}

export async function validateComputerSharingSettings(config: ServerConfig, input: unknown): Promise<ComputerSharingSettings> {
  const parsed = computerSharingSettingsSchema.safeParse(input);
  if (!parsed.success) throw new ComputerSharingSettingsError("Choose existing folders and list each folder and source only once.");
  const folders: ComputerSharingSettings["folders"] = [];
  const home = await realpath(homedir()).catch(() => homedir());
  for (const folder of parsed.data.folders) {
    const canonical = await realpath(folder.path).catch(() => { throw new ComputerSharingSettingsError("Choose a folder that exists on this computer."); });
    if (canonical === "/") throw new ComputerSharingSettingsError("Choose a folder other than the root of this computer.");
    if (canonical === home) throw new ComputerSharingSettingsError("Choose a folder inside your home folder, not the home folder itself.");
    try { await resolveSandboxMounts([{ hostPath: canonical, guestPath: canonical, access: "ro" }], protectedMountPaths(config)); }
    catch (error) {
      if (error instanceof SandboxProtectedMountError) throw new ComputerSharingSettingsError("Choose a folder that doesn't overlap OpenWork's own storage.");
      if (error instanceof SandboxFolderError) throw new ComputerSharingSettingsError("Choose a folder that exists on this computer.");
      throw new ComputerSharingSettingsError("OpenWork couldn't verify that this folder is safe to share.");
    }
    if (!computerFolderSchema.safeParse(canonical).success) throw new ComputerSharingSettingsError("Choose a folder with a valid absolute path.");
    if (folders.some(({ path }) => insideSharedFolder(canonical, [path]) || insideSharedFolder(path, [canonical]))) {
      throw new ComputerSharingSettingsError("Shared folders can't overlap; choose one folder or the other.");
    }
    folders.push({ path: canonical, access: folder.access });
  }
  return { ...parsed.data, folders };
}

export async function readComputerSharingSettings(config: ServerConfig) {
  return await store.get(config, install) ?? structuredClone(DEFAULT_COMPUTER_SHARING_SETTINGS);
}
export const saveComputerSharingSettings = (config: ServerConfig, settings: ComputerSharingSettings) => store.set(config, install, settings);
