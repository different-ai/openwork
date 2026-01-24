import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(moduleDir, "..");
dotenv.config({ path: path.join(packageDir, ".env") });
dotenv.config();

export type ChannelName = "telegram" | "whatsapp";

export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";

export type OwpenbotConfigFile = {
  version: number;
  channels?: {
    whatsapp?: {
      dmPolicy?: DmPolicy;
      allowFrom?: string[];
      selfChatMode?: boolean;
      accounts?: Record<
        string,
        {
          authDir?: string;
          sendReadReceipts?: boolean;
        }
      >;
    };
    telegram?: {
      token?: string;
      enabled?: boolean;
    };
  };
};

export type Config = {
  configPath: string;
  configFile: OwpenbotConfigFile;
  opencodeUrl: string;
  opencodeDirectory: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  telegramToken?: string;
  telegramEnabled: boolean;
  whatsappAuthDir: string;
  whatsappAccountId: string;
  whatsappDmPolicy: DmPolicy;
  whatsappAllowFrom: Set<string>;
  whatsappSelfChatMode: boolean;
  whatsappEnabled: boolean;
  dataDir: string;
  dbPath: string;
  logFile: string;
  allowlist: Record<ChannelName, Set<string>>;
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

export function normalizeWhatsAppId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (trimmed.endsWith("@g.us")) return trimmed;
  const base = trimmed.replace(/@s\.whatsapp\.net$/i, "");
  if (base.startsWith("+")) return base;
  if (/^\d+$/.test(base)) return `+${base}`;
  return base;
}

function normalizeWhatsAppAllowFrom(list: string[]): Set<string> {
  const set = new Set<string>();
  for (const entry of list) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed === "*") {
      set.add("*");
      continue;
    }
    set.add(normalizeWhatsAppId(trimmed));
  }
  return set;
}

function normalizeDmPolicy(value: unknown): DmPolicy {
  if (value === "allowlist" || value === "open" || value === "disabled" || value === "pairing") {
    return value;
  }
  return "pairing";
}

function resolveConfigPath(dataDir: string, env: EnvLike): string {
  const override = env.OWPENBOT_CONFIG_PATH?.trim();
  if (override) return expandHome(override);
  return path.join(dataDir, "owpenbot.json");
}

export function readConfigFile(configPath: string): { exists: boolean; config: OwpenbotConfigFile } {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as OwpenbotConfigFile;
    return { exists: true, config: parsed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, config: { version: 1 } };
    }
    throw error;
  }
}

export function writeConfigFile(configPath: string, config: OwpenbotConfigFile) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
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
  const requireOpencode = options.requireOpencode ?? false;
  const opencodeDirectory = env.OPENCODE_DIRECTORY?.trim() ?? "";
  if (!opencodeDirectory && requireOpencode) {
    throw new Error("OPENCODE_DIRECTORY is required");
  }
  const resolvedDirectory = opencodeDirectory || process.cwd();

  const dataDir = expandHome(env.OWPENBOT_DATA_DIR ?? "~/.owpenbot");
  const dbPath = expandHome(env.OWPENBOT_DB_PATH ?? path.join(dataDir, "owpenbot.db"));
  const logFile = expandHome(env.OWPENBOT_LOG_FILE ?? path.join(dataDir, "logs", "owpenbot.log"));
  const configPath = resolveConfigPath(dataDir, env);
  const { config: configFile } = readConfigFile(configPath);
  const whatsappFile = configFile.channels?.whatsapp ?? {};
  const whatsappAccountId = env.WHATSAPP_ACCOUNT_ID?.trim() || "default";
  const accountAuthDir = whatsappFile.accounts?.[whatsappAccountId]?.authDir;
  const whatsappAuthDir = expandHome(
    env.WHATSAPP_AUTH_DIR ??
      accountAuthDir ??
      path.join(dataDir, "credentials", "whatsapp", whatsappAccountId),
  );
  const dmPolicy = normalizeDmPolicy(
    env.WHATSAPP_DM_POLICY?.trim().toLowerCase() ?? whatsappFile.dmPolicy,
  );
  const selfChatMode = parseBoolean(env.WHATSAPP_SELF_CHAT, whatsappFile.selfChatMode ?? false);
  const envAllowlist = parseAllowlist(env);
  const fileAllowFrom = normalizeWhatsAppAllowFrom(whatsappFile.allowFrom ?? []);
  const envAllowFrom = normalizeWhatsAppAllowFrom(
    envAllowlist.whatsapp.size ? [...envAllowlist.whatsapp] : [],
  );
  const whatsappAllowFrom = new Set<string>([...fileAllowFrom, ...envAllowFrom]);

  const toolOutputLimit = parseInteger(env.TOOL_OUTPUT_LIMIT) ?? 1200;
  const permissionMode = env.PERMISSION_MODE?.toLowerCase() === "deny" ? "deny" : "allow";

  const telegramToken = env.TELEGRAM_BOT_TOKEN?.trim() || configFile.channels?.telegram?.token || undefined;

  return {
    configPath,
    configFile,
    opencodeUrl: env.OPENCODE_URL?.trim() ?? "http://127.0.0.1:4096",
    opencodeDirectory: resolvedDirectory,
    opencodeUsername: env.OPENCODE_SERVER_USERNAME?.trim() || undefined,
    opencodePassword: env.OPENCODE_SERVER_PASSWORD?.trim() || undefined,
    telegramToken,
    telegramEnabled: parseBoolean(
      env.TELEGRAM_ENABLED,
      configFile.channels?.telegram?.enabled ?? Boolean(telegramToken),
    ),
    whatsappAuthDir,
    whatsappAccountId,
    whatsappDmPolicy: dmPolicy,
    whatsappAllowFrom,
    whatsappSelfChatMode: selfChatMode,
    whatsappEnabled: parseBoolean(env.WHATSAPP_ENABLED, true),
    dataDir,
    dbPath,
    logFile,
    allowlist: envAllowlist,
    toolUpdatesEnabled: parseBoolean(env.TOOL_UPDATES_ENABLED, false),
    groupsEnabled: parseBoolean(env.GROUPS_ENABLED, false),
    permissionMode,
    toolOutputLimit,
    healthPort: parseInteger(env.OWPENBOT_HEALTH_PORT),
    logLevel: env.LOG_LEVEL?.trim() || "info",
  };
}
