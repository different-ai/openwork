import { join } from "node:path";
import { runtimeStorageDir } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";

export function cloudSkillFoldersRoot(config: Pick<ServerConfig, "configPath">): string {
  return join(runtimeStorageDir(config), "cloud-skill-folders");
}
