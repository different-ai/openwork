/**
 * Single entry point for embedding the OpenWork server in-process.
 *
 * Handles config resolution, managed OpenCode spawn, and server start
 * in one call -- mirrors what cli.ts does but returns a handle instead
 * of owning the process lifecycle.
 */
import { mkdir } from "node:fs/promises";
import { resolveServerConfig, type CliArgs } from "./config.js";
import { createManagedOpencodeServer, type ManagedOpencodeServer } from "./managed-opencode.js";
import { startServer } from "./server.js";
import { ensureWorkspaceFiles } from "./workspace-init.js";
import { openworkExtensionsPreviewPluginPath } from "./openwork-extensions-plugin-path.js";
import type { ServeResult } from "./serve-node.js";
import type { ServerConfig } from "./types.js";

export type EmbeddedServerOptions = CliArgs & {
  /** When true, spawn a managed OpenCode child process. */
  manageOpencode?: boolean;
  /** Path to the OpenCode binary. Falls back to OPENWORK_OPENCODE_BIN env. */
  opencodeBin?: string;
  /** Working directory for the managed OpenCode process. */
  opencodeCwd?: string;
};

export type EmbeddedServerHandle = {
  /** Bound port the HTTP server is listening on. */
  port: number;
  /** Full base URL, e.g. http://127.0.0.1:48123 */
  url: string;
  /** The resolved server config (with OpenCode URLs populated). */
  config: ServerConfig;
  /** Stop the HTTP server and managed OpenCode (if any). */
  stop: () => Promise<void>;
};

export async function startEmbeddedServer(options: EmbeddedServerOptions): Promise<EmbeddedServerHandle> {
  const config = await resolveServerConfig(options);
  const serverUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
  const opencodeModelsUrl = process.env.OPENWORK_DEV_MODE === "1"
    ? "http://localhost:8791/models"
    : "https://models.openworklabs.com/";

  // Spawn managed OpenCode if requested and no explicit base URL was provided.
  let managedOpencode: ManagedOpencodeServer | null = null;

  if (!config.readOnly) {
    for (const workspace of config.workspaces) {
      await ensureWorkspaceFiles(workspace.path, workspace.preset ?? "starter");
    }
  }

  if (!config.opencodeBaseUrl && options.manageOpencode) {
    const workspace = config.workspaces[0];
    if (workspace?.path) {
      const openworkExtensionsPreviewConfig = JSON.stringify({
        plugin: [
          "opencode-chrome-devtools",
          openworkExtensionsPreviewPluginPath(),
        ],
      });
      const cwd = options.opencodeCwd
        || process.env.OPENWORK_MANAGED_OPENCODE_CWD?.trim()
        || workspace.path;
      await mkdir(cwd, { recursive: true });

      managedOpencode = await createManagedOpencodeServer({
        bin: options.opencodeBin || process.env.OPENWORK_OPENCODE_BIN,
        cwd,
        env: {
          ...(process.env.OPENWORK_DEV_MODE ? { OPENWORK_DEV_MODE: process.env.OPENWORK_DEV_MODE } : {}),
          OPENWORK_SERVER_URL: serverUrl,
          OPENWORK_SERVER_TOKEN: config.token,
          OPENCODE_CONFIG_CONTENT: openworkExtensionsPreviewConfig,
          OPENCODE_MODELS_URL: opencodeModelsUrl,
        },
      });

      config.opencodeBaseUrl = managedOpencode.url;
      config.opencodeUsername = managedOpencode.username;
      config.opencodePassword = managedOpencode.password;
      for (const entry of config.workspaces) {
        if (entry.workspaceType === "remote") {
          entry.baseUrl ??= managedOpencode.url;
          entry.opencodeUsername ??= managedOpencode.username;
          entry.opencodePassword ??= managedOpencode.password;
          entry.directory ??= entry.path;
          continue;
        }
        entry.baseUrl = managedOpencode.url;
        entry.opencodeUsername = managedOpencode.username;
        entry.opencodePassword = managedOpencode.password;
        entry.directory = entry.path;
      }
    }
  }

  const server = await startServer(config);

  return {
    port: server.port,
    url: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${server.port}`,
    config,
    async stop() {
      managedOpencode?.close();
      await server.stop();
    },
  };
}
