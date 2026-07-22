/**
 * Single entry point for embedding the OpenWork server in-process.
 *
 * Handles config resolution, managed OpenCode spawn, and server start
 * in one call -- mirrors what cli.ts does but returns a handle instead
 * of owning the process lifecycle.
 */
import { mkdir } from "node:fs/promises";
import { resolveServerConfig, type CliArgs } from "./config.js";
import { createManagedOpencodeServer, type ManagedOpencodeServer, type OpencodeExecutionSnapshot } from "./managed-opencode.js";
import {
  clearTrustedOpencodeProcess,
  registerTrustedOpencodeProcess,
  startServer,
  syncAllWorkspacesRuntimeMcpToEngine,
} from "./server.js";
import { ensureLocalWorkspaceFiles } from "./workspace-init.js";
import { findManagedEngineWorkspace } from "./workspaces.js";
import {
  keepOpenworkRuntimeConfigFileFresh,
  openworkAgentPromptLength,
  openworkAgentPromptSha256,
  writeOpenworkRuntimeConfigFile,
} from "./openwork-runtime-config.js";
import { createServerObservabilityController } from "./observability.js";
import { sweepLegacyOpenCodeConfig } from "./legacy-config-sweep.js";
import type { ServeResult } from "./serve-node.js";
import type { ServerConfig } from "./types.js";

export type EmbeddedServerOptions = CliArgs & {
  /** When true, spawn a managed OpenCode child process. */
  manageOpencode?: boolean;
  /** Path to the OpenCode binary. Falls back to OPENWORK_OPENCODE_BIN env. */
  opencodeBin?: string;
  /** Working directory for the managed OpenCode process. */
  opencodeCwd?: string;
  /** Initial bounded observability configuration supplied by the desktop owner. */
  observability?: unknown;
};

export type EmbeddedServerHandle = {
  /** Bound port the HTTP server is listening on. */
  port: number;
  /** Full base URL, e.g. http://127.0.0.1:48123 */
  url: string;
  /** The resolved server config (with OpenCode URLs populated). */
  config: ServerConfig;
  /** Redacted details for the managed OpenCode child process, when spawned. */
  managedOpencodeExecution: OpencodeExecutionSnapshot | null;
  /** Liveness for the managed OpenCode child process, when spawned. */
  managedOpencode: { pid: number | null; isAlive: () => boolean } | null;
  /** Main-process owner controls; never exposed through the renderer bridge. */
  configureObservability: (input: unknown) => void;
  heartbeatObservability: () => void;
  /** Stop the HTTP server and managed OpenCode (if any). */
  stop: () => Promise<void>;
};

export async function startEmbeddedServer(options: EmbeddedServerOptions): Promise<EmbeddedServerHandle> {
  const config = await resolveServerConfig(options);
  const observability = createServerObservabilityController(options.observability);
  const opencodeModelsUrl = process.env.OPENWORK_DEV_MODE === "1"
    ? "http://localhost:8791/models"
    : "https://models.openworklabs.com/";

  // Spawn managed OpenCode if requested and no explicit base URL was provided.
  let managedOpencode: ManagedOpencodeServer | null = null;
  let managedOpencodeIdentity: string | null = null;

  if (!config.readOnly) {
    await ensureLocalWorkspaceFiles(config.workspaces);
  }

  // Bind first so the managed plugin always receives the real reachable port,
  // including port:0 and EADDRINUSE fallback cases.
  const server = await startServer(config, { observability });
  const serverUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${server.port}`;

  try {
    if (!config.opencodeBaseUrl && options.manageOpencode) {
      const workspace = findManagedEngineWorkspace(config.workspaces);
      if (workspace) {
        // Server-managed config file: the engine re-reads it from disk on every
        // instance rebuild, and keepOpenworkRuntimeConfigFileFresh rewrites it
        // on every runtime-DB write — so disposes always pick up current state.
        const runtimeConfigPath = await writeOpenworkRuntimeConfigFile(config, workspace.id, observability);
        keepOpenworkRuntimeConfigFileFresh(config, workspace.id, observability);
        const cwd = options.opencodeCwd
          || process.env.OPENWORK_MANAGED_OPENCODE_CWD?.trim()
          || workspace.path;
        await mkdir(cwd, { recursive: true });
        await sweepLegacyOpenCodeConfig(config).catch(() => undefined);

        managedOpencode = await createManagedOpencodeServer({
          bin: options.opencodeBin || process.env.OPENWORK_OPENCODE_BIN,
          cwd,
          excludedPorts: [server.port],
          env: {
            ...(process.env.OPENWORK_DEV_MODE ? { OPENWORK_DEV_MODE: process.env.OPENWORK_DEV_MODE } : {}),
            ...(process.env.OPENWORK_UI_CONTROL_DISCOVERY ? { OPENWORK_UI_CONTROL_DISCOVERY: process.env.OPENWORK_UI_CONTROL_DISCOVERY } : {}),
            OPENWORK_SERVER_URL: serverUrl,
            OPENWORK_SERVER_TOKEN: config.token,
            OPENWORK_OBSERVABILITY_TOKEN: observability.getInternalToken(),
            OPENWORK_AGENT_PROMPT_SHA256: openworkAgentPromptSha256(),
            OPENWORK_AGENT_PROMPT_LENGTH: String(openworkAgentPromptLength()),
            OPENCODE_CONFIG: runtimeConfigPath,
            OPENCODE_MODELS_URL: opencodeModelsUrl,
          },
          observe: (event) => {
            observability.record(event);
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
        managedOpencodeIdentity = [
          managedOpencode.pid ?? "unknown",
          managedOpencode.username,
          managedOpencode.password,
        ].join(":");
        registerTrustedOpencodeProcess(config, {
          baseUrl: managedOpencode.url,
          identity: managedOpencodeIdentity,
          isAlive: managedOpencode.isAlive,
        });
      }
    }
  } catch (error) {
    await server.stop();
    throw error;
  }

  // The runtime config file above only covers workspaces[0]. Push every
  // workspace's runtime-DB MCPs into the engine so they aren't invisible
  // until a manual reload. Best-effort.
  if (managedOpencode) {
    void syncAllWorkspacesRuntimeMcpToEngine(config);
  }

  return {
    port: server.port,
    url: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${server.port}`,
    config,
    managedOpencodeExecution: managedOpencode?.execution ?? null,
    managedOpencode: managedOpencode
      ? { pid: managedOpencode.pid ?? null, isAlive: managedOpencode.isAlive }
      : null,
    configureObservability(input) {
      observability.configure(input);
    },
    heartbeatObservability() {
      observability.heartbeat();
    },
    async stop() {
      if (managedOpencodeIdentity) {
        clearTrustedOpencodeProcess(config, managedOpencodeIdentity);
      }
      await managedOpencode?.close();
      await server.stop();
    },
  };
}
