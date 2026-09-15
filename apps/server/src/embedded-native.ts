import { startEmbeddedServer as startSharedServer } from "./embedded.js";
import type { EmbeddedServerHandle, EmbeddedServerOptions } from "./embedded.js";

/** Node/Electron-only entry for hosts that do not ship the legacy SDK or Bun ORM. */
export async function startEmbeddedServer(options: EmbeddedServerOptions): Promise<EmbeddedServerHandle> {
  if (options.engine !== "v2") throw new Error("The native embedded runtime requires OpenCode v2");
  if (typeof process.versions.bun === "string") throw new Error("The native embedded runtime requires Node or Electron");
  return startSharedServer(options);
}
