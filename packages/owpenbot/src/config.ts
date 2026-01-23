import os from "node:os";
import path from "node:path";

import dotenv from "dotenv";

dotenv.config();

export type ChannelName = "telegram" | "whatsapp";

export type Config = {
  opencodeUrl: string;
  opencodeDirectory: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  telegramToken?: string;
  telegramEnabled: boolean;
  whatsappAuthDir: string;
  whatsappEnabled: boolean;
  dataDir: string;
  dbPath: string;
  allowlist: Record<ChannelName, Set<string>>;
  pairingCode?: string;
  toolUpdatesEnabled: boolean;
  groupsEnabled: boolean;
  permissionMode: "allow" | "deny";
  toolOutputLimit: number;
  healthPort?: number;
  logLevel: string;
};

type EnvLike = NodeJS.ProcessEnv;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function expandHome(value: string): string {
  if (!value.startsWith("~/")) return value;
  return path.join(os.homedir(), value.slice(2));
}

function parseAllowlist(env: EnvLike): Record<ChannelName, Set<string>> {
  const allowlist: Record<ChannelName, Set<string>> = {
    telegram: new Set<string>(),
    whatsapp: new Set<string>(),
  };

  const shared = parseList(env.ALLOW_FROM);
  for (const entry of shared) {
    if (entry.includes(":")) {
      const [channel, peer] = entry.split(":");
      const normalized = channel.trim().toLowerCase();
      if (normalized === "telegram" || normalized === "whatsapp") {
        if (peer?.trim()) {
          allowlist[normalized].add(peer.trim());
        }
      }
    } else {
      allowlist.telegram.add(entry);
      allowlist.whatsapp.add(entry);
    }
  }

  for (const entry of parseList(env.ALLOW_FROM_TELEGRAM)) {
    allowlist.telegram.add(entry);
  }
  for (const entry of parseList(env.ALLOW_FROM_WHATSAPP)) {
    allowlist.whatsapp.add(entry);
  }

  return allowlist;
}

export function loadConfig(
  env: EnvLike = process.env,
  options: { requireOpencode?: boolean } = {},
): Config {
  const requireOpencode = options.requireOpencode ?? true;
  const opencodeDirectory = env.OPENCODE_DIRECTORY?.trim();
  if (!opencodeDirectory && requireOpencode) {
    throw new Error("OPENCODE_DIRECTORY is required");
  }
  const resolvedDirectory = opencodeDirectory || process.cwd();

  const dataDir = expandHome(env.OWPENBOT_DATA_DIR ?? "~/.owpenbot");
  const dbPath = expandHome(env.OWPENBOT_DB_PATH ?? path.join(dataDir, "owpenbot.db"));
  const whatsappAuthDir = expandHome(env.WHATSAPP_AUTH_DIR ?? path.join(dataDir, "whatsapp"));

  const toolOutputLimit = parseInteger(env.TOOL_OUTPUT_LIMIT) ?? 1200;
  const permissionMode = env.PERMISSION_MODE?.toLowerCase() === "deny" ? "deny" : "allow";

  return {
    opencodeUrl: env.OPENCODE_URL?.trim() ?? "http://127.0.0.1:4096",
    opencodeDirectory: resolvedDirectory,
    opencodeUsername: env.OPENCODE_SERVER_USERNAME?.trim() || undefined,
    opencodePassword: env.OPENCODE_SERVER_PASSWORD?.trim() || undefined,
    telegramToken: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    telegramEnabled: parseBoolean(env.TELEGRAM_ENABLED, Boolean(env.TELEGRAM_BOT_TOKEN?.trim())),
    whatsappAuthDir,
    whatsappEnabled: parseBoolean(env.WHATSAPP_ENABLED, true),
    dataDir,
    dbPath,
    allowlist: parseAllowlist(env),
    pairingCode: env.PAIRING_CODE?.trim() || undefined,
    toolUpdatesEnabled: parseBoolean(env.TOOL_UPDATES_ENABLED, false),
    groupsEnabled: parseBoolean(env.GROUPS_ENABLED, false),
    permissionMode,
    toolOutputLimit,
    healthPort: parseInteger(env.OWPENBOT_HEALTH_PORT),
    logLevel: env.LOG_LEVEL?.trim() || "info",
  };
}
