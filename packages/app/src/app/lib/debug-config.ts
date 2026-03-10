import { parse } from "jsonc-parser";

import { isTauriRuntime } from "../utils";
import { readOpenworkServerSettings, type OpenworkServerSettings } from "./openwork-server";
import { readOpencodeConfig, workspaceOpenworkRead, type WorkspaceOpenworkConfig } from "./tauri";
import { redactRecord, redactUnknown, redactValue, type DebugRedactedValue } from "./debug-log";

export type DebugConfigSnapshot = {
  collectedAt: string;
  app: {
    openworkServerSettings: {
      urlOverride?: string;
      portOverride?: number;
      token?: DebugRedactedValue | null;
    };
  };
  workspace?: {
    id?: string;
    name?: string;
    type?: string;
    path?: string;
  };
  openworkConfig?: DebugConfigEntry;
  opencodeConfig?: DebugConfigEntry;
  notes: string[];
};

export type DebugConfigEntry = {
  source: "tauri" | "server";
  payload?: Record<string, unknown>;
  error?: string;
};

type DebugConfigInput = {
  workspaceId?: string | null;
  workspaceName?: string | null;
  workspaceType?: string | null;
  workspacePath?: string | null;
  openworkServerClient?: { getConfig: (workspaceId: string) => Promise<{ opencode: Record<string, unknown>; openwork: Record<string, unknown> }> } | null;
  openworkServerWorkspaceId?: string | null;
};

const OPENCODE_CONFIG_ALLOWLIST = new Set([
  "version",
  "providers",
  "models",
  "mcp",
  "plugins",
  "skills",
  "commands",
  "agents",
  "router",
  "sandbox",
  "policy",
  "workspace",
]);

const OPENWORK_CONFIG_ALLOWLIST = new Set([
  "version",
  "workspace",
  "authorizedRoots",
  "reload",
]);

const pickAllowlist = (input: Record<string, unknown>, allowlist: Set<string>) => {
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (allowlist.has(key)) {
      next[key] = redactUnknown(input[key]);
    }
  }
  return next;
};

const readJsonc = (content: string) => {
  try {
    const parsed = parse(content) as Record<string, unknown> | null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const sanitizeOpencodeConfig = (raw: Record<string, unknown>) => pickAllowlist(raw, OPENCODE_CONFIG_ALLOWLIST);
const sanitizeOpenworkConfig = (raw: Record<string, unknown>) => pickAllowlist(raw, OPENWORK_CONFIG_ALLOWLIST);

const redactOpenworkServerSettings = (settings: OpenworkServerSettings) => ({
  urlOverride: settings.urlOverride,
  portOverride: settings.portOverride,
  token: settings.token ? redactValue("token") : null,
});

export async function collectDebugConfigSnapshots(input: DebugConfigInput): Promise<DebugConfigSnapshot> {
  const notes: string[] = [];
  const snapshot: DebugConfigSnapshot = {
    collectedAt: new Date().toISOString(),
    app: {
      openworkServerSettings: redactOpenworkServerSettings(readOpenworkServerSettings()),
    },
    notes,
  };

  if (input.workspaceId || input.workspaceName || input.workspaceType || input.workspacePath) {
    snapshot.workspace = {
      id: input.workspaceId ?? undefined,
      name: input.workspaceName ?? undefined,
      type: input.workspaceType ?? undefined,
      path: input.workspacePath ?? undefined,
    };
  }

  if (input.openworkServerClient && input.openworkServerWorkspaceId) {
    try {
      const config = await input.openworkServerClient.getConfig(input.openworkServerWorkspaceId);
      snapshot.opencodeConfig = {
        source: "server",
        payload: sanitizeOpencodeConfig(config.opencode ?? {}),
      };
      snapshot.openworkConfig = {
        source: "server",
        payload: sanitizeOpenworkConfig(config.openwork ?? {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to read OpenWork server config";
      snapshot.opencodeConfig = { source: "server", error: message };
      snapshot.openworkConfig = { source: "server", error: message };
      notes.push(message);
    }
  }

  if (isTauriRuntime() && input.workspacePath) {
    try {
      const opencode = await readOpencodeConfig("project", input.workspacePath);
      const parsed = opencode.content ? readJsonc(opencode.content) : null;
      if (parsed) {
        snapshot.opencodeConfig = {
          source: "tauri",
          payload: sanitizeOpencodeConfig(parsed),
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to read opencode config";
      snapshot.opencodeConfig = { source: "tauri", error: message };
      notes.push(message);
    }

    try {
      const openwork = await workspaceOpenworkRead({ workspacePath: input.workspacePath });
      snapshot.openworkConfig = {
        source: "tauri",
        payload: sanitizeOpenworkConfig(redactRecord(openwork) as Record<string, unknown>),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to read openwork config";
      snapshot.openworkConfig = { source: "tauri", error: message };
      notes.push(message);
    }
  }

  if (notes.length === 0) {
    notes.push("Config snapshot collected with allowlisted keys and redaction.");
  }

  return snapshot;
}
