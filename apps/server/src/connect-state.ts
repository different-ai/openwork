import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { googleWorkspaceLegacyConfigured } from "./extensions/google-workspace.js";
import {
  readRuntimeOpencodeConfig,
  runtimeMcpMap,
  runtimeStorageDir,
} from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import { ensureDir } from "./utils.js";

const CONNECT_STATE_FILE = "connect-state.json";
const OPENWORK_CLOUD_MCP_NAME = "openwork-cloud";

type PersistedConnectState = {
  connectEnabled: boolean;
  updatedAt: number;
};

export type ConnectSnapshot = {
  connectEnabled: boolean;
  cloudMcpPresent: boolean;
  googleWorkspace: {
    legacyConfigured: boolean;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function connectStatePath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), CONNECT_STATE_FILE);
}

function normalizeConnectState(value: unknown): PersistedConnectState {
  if (!isRecord(value) || typeof value.connectEnabled !== "boolean") {
    return { connectEnabled: false, updatedAt: 0 };
  }
  return {
    connectEnabled: value.connectEnabled,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
  };
}

export function googleWorkspaceConnectGuidance(cloudMcpPresent: boolean): string {
  return cloudMcpPresent
    ? "Google Workspace is available through the OpenWork Cloud connection: call search_capabilities to find the capability, then execute_capability to run it. Do not tell the user to reconfigure extensions; the relevant settings surface is Settings > Connect."
    : "Google Workspace is not connected on this device. Direct the user to Settings > Connect to connect their account. Do not direct them to Settings > Extensions.";
}

export async function readConnectState(config: ServerConfig): Promise<PersistedConnectState> {
  try {
    const raw = await readFile(connectStatePath(config), "utf8");
    return normalizeConnectState(JSON.parse(raw));
  } catch {
    return { connectEnabled: false, updatedAt: 0 };
  }
}

export async function writeConnectState(config: ServerConfig, state: { connectEnabled: boolean }): Promise<PersistedConnectState> {
  const next = { connectEnabled: state.connectEnabled, updatedAt: Date.now() };
  const target = connectStatePath(config);
  await ensureDir(runtimeStorageDir(config));
  await writeFile(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export async function getConnectSnapshot(config: ServerConfig): Promise<ConnectSnapshot> {
  const state = await readConnectState(config);
  let cloudMcpPresent = false;

  for (const workspace of config.workspaces) {
    const runtimeConfig = await readRuntimeOpencodeConfig(config, workspace.id);
    if (Object.hasOwn(runtimeMcpMap(runtimeConfig), OPENWORK_CLOUD_MCP_NAME)) {
      cloudMcpPresent = true;
      break;
    }
  }

  return {
    connectEnabled: state.connectEnabled,
    cloudMcpPresent,
    googleWorkspace: {
      legacyConfigured: googleWorkspaceLegacyConfigured(),
    },
  };
}

export function shouldGateLegacyGoogleWorkspace(snapshot: ConnectSnapshot): boolean {
  return snapshot.connectEnabled && !snapshot.googleWorkspace.legacyConfigured;
}

export function googleWorkspaceStatusConnectExtra(snapshot: ConnectSnapshot): Record<string, unknown> {
  if (!shouldGateLegacyGoogleWorkspace(snapshot)) return {};
  return {
    connect: {
      enabled: true,
      cloudMcpPresent: snapshot.cloudMcpPresent,
      guidance: googleWorkspaceConnectGuidance(snapshot.cloudMcpPresent),
    },
  };
}
