import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readBoundedRegularTextFile } from "./jsonc.js";
import { runtimeStorageDir } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";
import { ensureDir } from "./utils.js";

const DESKTOP_POLICY_STATE_FILE = "desktop-policy-state.json";
const DESKTOP_POLICY_STATE_MAX_BYTES = 16 * 1024;

export type DesktopPolicyState = {
  allowCreateSkills: boolean;
  allowAddMcpServers: boolean;
  updatedAt: number;
};

export type DesktopPolicyStateInspectionStatus = "available" | "missing" | "invalid" | "unreadable";

export type DesktopPolicyStateInspection = {
  status: DesktopPolicyStateInspectionStatus;
  state: DesktopPolicyState;
};

export type DesktopPolicyStateInspectionOptions = {
  maxBytes?: number;
  signal?: AbortSignal;
};

const DEFAULT_DESKTOP_POLICY_STATE: DesktopPolicyState = {
  allowCreateSkills: true,
  allowAddMcpServers: true,
  updatedAt: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function desktopPolicyStatePath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), DESKTOP_POLICY_STATE_FILE);
}

export async function readDesktopPolicyState(config: ServerConfig): Promise<DesktopPolicyState> {
  return (await inspectDesktopPolicyState(config)).state;
}

export async function inspectDesktopPolicyState(
  config: ServerConfig,
  options?: DesktopPolicyStateInspectionOptions,
): Promise<DesktopPolicyStateInspection> {
  try {
    const raw = await readBoundedRegularTextFile(desktopPolicyStatePath(config), {
      maxBytes: options?.maxBytes ?? DESKTOP_POLICY_STATE_MAX_BYTES,
      signal: options?.signal,
    });
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed)
      || typeof parsed.allowCreateSkills !== "boolean"
      || typeof parsed.allowAddMcpServers !== "boolean"
    ) {
      return { status: "invalid", state: DEFAULT_DESKTOP_POLICY_STATE };
    }
    return {
      status: "available",
      state: {
        allowCreateSkills: parsed.allowCreateSkills,
        allowAddMcpServers: parsed.allowAddMcpServers,
        updatedAt: typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt)
          ? parsed.updatedAt
          : 0,
      },
    };
  } catch (error) {
    options?.signal?.throwIfAborted();
    if (isRecord(error) && error.code === "ENOENT") {
      return { status: "missing", state: DEFAULT_DESKTOP_POLICY_STATE };
    }
    if (error instanceof SyntaxError) {
      return { status: "invalid", state: DEFAULT_DESKTOP_POLICY_STATE };
    }
    return { status: "unreadable", state: DEFAULT_DESKTOP_POLICY_STATE };
  }
}

async function persistDesktopPolicyState(
  config: ServerConfig,
  state: DesktopPolicyState,
): Promise<DesktopPolicyState> {
  await ensureDir(runtimeStorageDir(config));
  await writeFile(desktopPolicyStatePath(config), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

export async function writeDesktopPolicyState(
  config: ServerConfig,
  state: Pick<DesktopPolicyState, "allowCreateSkills" | "allowAddMcpServers">,
): Promise<DesktopPolicyState> {
  const current = await readDesktopPolicyState(config);
  return persistDesktopPolicyState(config, {
    ...current,
    ...state,
    updatedAt: Date.now(),
  });
}
