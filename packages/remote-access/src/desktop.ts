import { lstat, readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseFeatureEnvironment,
  resolveFeature,
} from "@openwork/features/resolve";
import { BridgeError } from "./contract/index.js";
import { Store } from "./storage/store.js";

/** Development-only operator policy. Packaged desktop uses Den's resolved map. */
export function localRemoteAccessPolicy(
  env: Record<string, string | undefined>,
) {
  const context = parseFeatureEnvironment(env);
  if (context.problems.some((problem) => problem.fatal))
    throw new BridgeError("INVALID_FEATURE_ENVIRONMENT");
  if (!Object.hasOwn(context.locks, "remoteAccess")) return null;
  return resolveFeature("remoteAccess", {
    ...context,
    rollouts: {},
    overrides: {},
  });
}

export async function readSavedDevices(root: string) {
  const state = await Store.read(root);
  return (
    state?.devices
      .filter((d) => !d.revoked)
      .map((d) => ({
        id: d.id,
        name: d.name,
        workspaceIds: d.workspaceIds,
        allWorkspaces: d.allWorkspaces ?? false,
        active: d.active,
      })) ?? []
  );
}

/** Preference lives separately from the device store, with the same private modes. */
export function remoteAccessPreference(root: string) {
  const file = join(root, "desktop.json");
  const ensureDirectory = async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o700
    )
      throw new BridgeError("UNSAFE_PERMISSIONS");
  };
  return {
    async read() {
      try {
        await ensureDirectory();
        const info = await lstat(file);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.uid !== process.getuid?.() ||
          (info.mode & 0o777) !== 0o600 ||
          info.size > 1024
        )
          throw new BridgeError("UNSAFE_PERMISSIONS");
        const value: unknown = JSON.parse(await readFile(file, "utf8"));
        if (
          !value ||
          typeof value !== "object" ||
          !("enabled" in value) ||
          typeof value.enabled !== "boolean"
        )
          throw new BridgeError("INVALID_STORE");
        return value.enabled;
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return false;
        throw error instanceof BridgeError
          ? error
          : new BridgeError("INVALID_STORE");
      }
    },
    async write(enabled: boolean) {
      await ensureDirectory();
      const temp = join(root, `desktop-${randomUUID()}.tmp`);
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ enabled }));
        await handle.sync();
        await handle.close();
        await rename(temp, file);
        const directory = await open(root, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch {
        await handle.close().catch(() => {});
        await unlink(temp).catch(() => {});
        throw new BridgeError("STORE_UNAVAILABLE");
      }
    },
  };
}
