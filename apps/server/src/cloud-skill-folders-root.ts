import { join } from "node:path";
import { runtimeStorageDir } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";

/**
 * Where organization skills get their folders (cloud-skill-folders.ts). Not
 * `cloud-skills`: engine startup removes that folder, left by the old
 * materializer that copied every listed skill.
 */
export function cloudSkillFoldersRoot(config: Pick<ServerConfig, "configPath">): string {
  return join(runtimeStorageDir(config), "cloud-skill-folders");
}
