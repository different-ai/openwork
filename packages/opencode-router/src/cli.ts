#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";

import { Command } from "commander";
import { Bot } from "grammy";
import { WebClient } from "@slack/web-api";

import { startBridge, type BridgeReporter } from "./bridge.js";
import {
  loadConfig,
  readConfigFile,
  writeConfigFile,
  type ChannelName,
  type OpenCodeRouterConfigFile,
  type SlackIdentity,
  type TelegramIdentity,
} from "./config.js";
import { BridgeStore } from "./db.js";
import { createLogger } from "./logger.js";
import { createClient } from "./opencode.js";
import { parseSlackPeerId } from "./slack.js";
import { truncateText } from "./text.js";

declare const __OPENCODE_ROUTER_VERSION__: string | undefined;

const VERSION = (() => {
  if (typeof __OPENCODE_ROUTER_VERSION__ === "string" && __OPENCODE_ROUTER_VERSION__.trim()) {
    return __OPENCODE_ROUTER_VERSION__.trim();
  }
  try {
    const pkgPath = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch {
    // ignore
  }
  return "0.0.0";
})();

function outputJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

function outputError(message: string, exitCode = 1): never {
  if (program.opts().json) {
    outputJson({ error: message });
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(exitCode);
}

function createAppLogger(config: ReturnType<typeof loadConfig>) {
  return createLogger(config.logLevel, { logFile: config.logFile });
}

function createConsoleReporter(): BridgeReporter {
  const formatChannel = (channel: ChannelName, identityId: string) => {
    const name = channel === "telegram" ? "Telegram" : "Slack";
    return `${name}/${identityId}`;
  };

  const printBlock = (prefix: string, text: string) => {
    const lines = text.split(/\r?\n/).map((line) => truncateText(line.trim(), 240));
    const [first, ...rest] = lines.length ? lines : ["(empty)"];
    console.log(`${prefix} ${first}`);
    for (const line of rest) {
      console.log(`${" ".repeat(prefix.length)} ${line}`);
    }
  };

  return {
    onStatus(message) {
      console.log(message);
    },
    onInbound({ channel, identityId, peerId, text, fromMe }) {
      const base = fromMe ? `${peerId} (me)` : peerId;
      const prefix = `[${formatChannel(channel, identityId)}] ${base} >`;
      printBlock(prefix, text);
    },
    onOutbound({ channel, identityId, peerId, text, kind }) {
      const marker = kind === "reply" ? "<" : kind === "tool" ? "*" : "!";
      const prefix = `[${formatChannel(channel, identityId)}] ${peerId} ${marker}`;
      printBlock(prefix, text);
    },
  };
}

function updateConfig(configPath: string, updater: (cfg: OpenCodeRouterConfigFile) => OpenCodeRouterConfigFile) {
  const { config } = readConfigFile(configPath);
  const base = config ?? { version: 1 };
  const next = updater(base);
  next.version = next.version ?? 1;
  writeConfigFile(configPath, next);
  return next;
}

function normalizeIdentityId(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "default";
  const safe = trimmed.replace(/[^a-zA-Z0-9_.-]+/g, "-");
  const cleaned = safe.replace(/^-+|-+$/g, "").slice(0, 48);
  return cleaned || "default";
}

function upsertTelegramBot(cfg: OpenCodeRouterConfigFile, identity: TelegramIdentity): OpenCodeRouterConfigFile {
  const next = { ...cfg };
  next.channels = next.channels ?? {};
  const existing = next.channels.telegram ?? {};
  const bots = Array.isArray(existing.bots) ? existing.bots.slice() : [];
  const id = normalizeIdentityId(identity.id);
  const filtered = bots.filter((b) => normalizeIdentityId(b.id) !== id);
  filtered.push({ id, token: identity.token, enabled: identity.enabled !== false });
  next.channels.telegram = { ...existing, enabled: true, bots: filtered };
  return next;
}

function deleteTelegramBot(cfg: OpenCodeRouterConfigFile, idRaw: string): { next: OpenCodeRouterConfigFile; deleted: boolean } {
  const id = normalizeIdentityId(idRaw);
  const next = { ...cfg };
  next.channels = next.channels ?? {};
  const existing = next.channels.telegram ?? {};
  const bots = Array.isArray(existing.bots) ? existing.bots.slice() : [];
  const filtered = bots.filter((b) => normalizeIdentityId(b.id) !== id);
  const deleted = filtered.length !== bots.length;
  next.channels.telegram = { ...existing, bots: filtered };
  return { next, deleted };
}

function upsertSlackApp(cfg: OpenCodeRouterConfigFile, identity: SlackIdentity): OpenCodeRouterConfigFile {
  const next = { ...cfg };
  next.channels = next.channels ?? {};
  const existing = next.channels.slack ?? {};
  const apps = Array.isArray(existing.apps) ? existing.apps.slice() : [];
  const id = normalizeIdentityId(identity.id);
  const filtered = apps.filter((a) => normalizeIdentityId(a.id) !== id);
  filtered.push({ id, botToken: identity.botToken, appToken: identity.appToken, enabled: identity.enabled !== false });
  next.channels.slack = { ...existing, enabled: true, apps: filtered };
  return next;
}

function deleteSlackApp(cfg: OpenCodeRouterConfigFile, idRaw: string): { next: OpenCodeRouterConfigFile; deleted: boolean } {
  const id = normalizeIdentityId(idRaw);
  const next = { ...cfg };
  next.channels = next.channels ?? {};
  const existing = next.channels.slack ?? {};
  const apps = Array.isArray(existing.apps) ? existing.apps.slice() : [];
  const filtered = apps.filter((a) => normalizeIdentityId(a.id) !== id);
  const deleted = filtered.length !== apps.length;
  next.channels.slack = { ...existing, apps: filtered };
  return { next, deleted };
}

async function runStart(pathOverride?: string, options?: { opencodeUrl?: string }) {
  if (pathOverride?.trim()) {
    process.env.OPENCODE_DIRECTORY = pathOverride.trim();
  }
  if (options?.opencodeUrl?.trim()) {
    process.env.OPENCODE_URL = options.opencodeUrl.trim();
  }
  const config = loadConfig();
  const logger = createAppLogger(config);
  const reporter = createConsoleReporter();
  if (!process.env.OPENCODE_DIRECTORY) {
    process.env.OPENCODE_DIRECTORY = config.opencodeDirectory;
  }
  const bridge = await startBridge(config, logger, reporter);
  if (process.stdout.isTTY) {
    reporter.onStatus?.("Commands: opencode-router identities, opencode-router bindings, opencode-router status");
  }

  const shutdown = async () => {
    logger.info("shutting down");
    await bridge.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const program = new Command();

program
  .name("opencode-router")
  .version(VERSION)
  .description("opencode-router: Slack + Telegram bridge + directory routing")
  .option("--json", "Output in JSON format", false);

program
  .command("start")
  .description("Start the bridge")
  .argument("[path]", "opencode workspace path")
  .option("--opencode-url <url>", "opencode server URL")
  .action((pathArg?: string, options?: { opencodeUrl?: string }) => runStart(pathArg, options));

program
  .command("serve")
  .description("Start the bridge (headless)")
  .argument("[path]", "opencode workspace path")
  .option("--opencode-url <url>", "opencode server URL")
  .action((pathArg?: string, options?: { opencodeUrl?: string }) => runStart(pathArg, options));

program
  .command("health")
  .description("Check opencode health (exit 0 if healthy, 1 if not)")
  .action(async () => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    try {
      const client = createClient(config);
      const health = await client.global.health();
      const healthy = Boolean((health as { healthy?: boolean }).healthy);
      if (useJson) {
        outputJson({
          healthy,
          opencodeUrl: config.opencodeUrl,
          identities: {
            telegram: config.telegramBots.map((b) => ({ id: b.id, enabled: b.enabled !== false })),
            slack: config.slackApps.map((a) => ({ id: a.id, enabled: a.enabled !== false })),
          },
        });
      } else {
        console.log(`Healthy: ${healthy ? "yes" : "no"}`);
        console.log(`opencode URL: ${config.opencodeUrl}`);
      }
      process.exit(healthy ? 0 : 1);
    } catch (error) {
      if (useJson) {
        outputJson({
          healthy: false,
          error: String(error),
          opencodeUrl: config.opencodeUrl,
        });
      } else {
        console.log("Healthy: no");
        console.log(`Error: ${String(error)}`);
      }
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Show identity and opencode status")
  .action(() => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    const telegram = config.telegramBots.map((b) => ({ id: b.id, enabled: b.enabled !== false }));
    const slack = config.slackApps.map((a) => ({ id: a.id, enabled: a.enabled !== false }));
    if (useJson) {
      outputJson({
        config: config.configPath,
        healthPort: config.healthPort ?? null,
        telegram,
        slack,
        opencode: { url: config.opencodeUrl, directory: config.opencodeDirectory },
      });
      return;
    }
    console.log(`Config: ${config.configPath}`);
    console.log(`Health port: ${config.healthPort ?? "(not set)"}`);
    console.log(`Telegram bots: ${telegram.length}`);
    console.log(`Slack apps: ${slack.length}`);
    console.log(`opencode URL: ${config.opencodeUrl}`);
  });

// -----------------------------------------------------------------------------
// Config helpers
// -----------------------------------------------------------------------------

const configCmd = program.command("config").description("Manage configuration");

configCmd
  .command("get")
  .argument("[key]", "Config key to get (dot notation)")
  .description("Get config value(s)")
  .action((key?: string) => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    const { config: configFile } = readConfigFile(config.configPath);
    if (!key) {
      if (useJson) outputJson(configFile);
      else console.log(JSON.stringify(configFile, null, 2));
      return;
    }

    const keys = key.split(".");
    let current: any = configFile as any;
    for (const k of keys) {
      if (current === null || current === undefined || typeof current !== "object") {
        current = undefined;
        break;
      }
      current = current[k];
    }

    if (useJson) outputJson({ [key]: current });
    else console.log(`${key}: ${current === undefined ? "(not set)" : typeof current === "object" ? JSON.stringify(current, null, 2) : current}`);
  });

configCmd
  .command("set")
  .argument("<key>", "Config key to set (dot notation)")
  .argument("<value>", "Value to set (JSON for arrays/objects)")
  .description("Set config value")
  .action((key: string, value: string) => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    const parsed = (() => {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    })();

    const updated = updateConfig(config.configPath, (cfg) => {
      const next: any = { ...cfg };
      const keys = key.split(".");
      let cur: any = next;
      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i];
        if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== "object") cur[k] = {};
        cur = cur[k];
      }
      cur[keys[keys.length - 1]] = parsed;
      return next as OpenCodeRouterConfigFile;
    });

    if (useJson) outputJson({ success: true, key, value: parsed, config: updated });
    else console.log(`Set ${key} = ${JSON.stringify(parsed)}`);
  });

// -----------------------------------------------------------------------------
// Identities
// -----------------------------------------------------------------------------

const telegram = program.command("telegram").description("Telegram identities");

telegram
  .command("list")
  .description("List Telegram bot identities")
  .action(() => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    const items = config.telegramBots.map((b) => ({ id: b.id, enabled: b.enabled !== false }));
    if (useJson) outputJson({ items });
    else for (const item of items) console.log(`${item.id} ${item.enabled ? "enabled" : "disabled"}`);
  });

telegram
  .command("add")
  .argument("<token>", "Telegram bot token")
  .option("--id <id>", "Identity id (default: default)")
  .option("--disabled", "Add identity but disable it", false)
  .description("Add or update a Telegram bot identity")
  .action((token: string, opts: { id?: string; disabled?: boolean }) => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    const id = normalizeIdentityId(opts.id);
    const enabled = !opts.disabled;
    updateConfig(config.configPath, (cfg) => upsertTelegramBot(cfg, { id, token: token.trim(), enabled }));
    if (useJson) outputJson({ success: true, id, enabled });
    else console.log(`Saved Telegram identity: ${id}`);
  });

telegram
  .command("remove")
  .argument("<id>", "Identity id")
  .description("Remove a Telegram bot identity")
  .action((idRaw: string) => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    const { next, deleted } = deleteTelegramBot(readConfigFile(config.configPath).config, idRaw);
    writeConfigFile(config.configPath, next);
    if (useJson) outputJson({ success: deleted, id: normalizeIdentityId(idRaw) });
    else console.log(deleted ? `Removed Telegram identity: ${normalizeIdentityId(idRaw)}` : "Identity not found.");
    process.exit(deleted ? 0 : 1);
  });

const slack = program.command("slack").description("Slack identities");

slack
  .command("list")
  .description("List Slack app identities")
  .action(() => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    const items = config.slackApps.map((a) => ({ id: a.id, enabled: a.enabled !== false }));
    if (useJson) outputJson({ items });
    else for (const item of items) console.log(`${item.id} ${item.enabled ? "enabled" : "disabled"}`);
  });

slack
  .command("add")
  .argument("<botToken>", "Slack bot token (xoxb-...)")
  .argument("<appToken>", "Slack app token (xapp-...)")
  .option("--id <id>", "Identity id (default: default)")
  .option("--disabled", "Add identity but disable it", false)
  .description("Add or update a Slack app identity")
  .action((botToken: string, appToken: string, opts: { id?: string; disabled?: boolean }) => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    const id = normalizeIdentityId(opts.id);
    const enabled = !opts.disabled;
    updateConfig(config.configPath, (cfg) =>
      upsertSlackApp(cfg, { id, botToken: botToken.trim(), appToken: appToken.trim(), enabled }),
    );
    if (useJson) outputJson({ success: true, id, enabled });
    else console.log(`Saved Slack identity: ${id}`);
  });

slack
  .command("remove")
  .argument("<id>", "Identity id")
  .description("Remove a Slack identity")
  .action((idRaw: string) => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    const { next, deleted } = deleteSlackApp(readConfigFile(config.configPath).config, idRaw);
    writeConfigFile(config.configPath, next);
    if (useJson) outputJson({ success: deleted, id: normalizeIdentityId(idRaw) });
    else console.log(deleted ? `Removed Slack identity: ${normalizeIdentityId(idRaw)}` : "Identity not found.");
    process.exit(deleted ? 0 : 1);
  });

// -----------------------------------------------------------------------------
// Bindings
// -----------------------------------------------------------------------------

const bindings = program.command("bindings").description("Manage identity-scoped bindings");

bindings
  .command("list")
  .option("--channel <channel>", "telegram|slack")
  .option("--identity <id>", "Identity id")
  .description("List bindings")
  .action((opts: { channel?: string; identity?: string }) => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    const store = new BridgeStore(config.dbPath);
    const channelRaw = opts.channel?.trim().toLowerCase();
    const identityId = opts.identity?.trim() ? normalizeIdentityId(opts.identity) : undefined;
    const channel: ChannelName | undefined =
      channelRaw === "telegram" || channelRaw === "slack" ? (channelRaw as ChannelName) : channelRaw ? (outputError("Invalid channel"), undefined) : undefined;
    const items = store
      .listBindings({ ...(channel ? { channel } : {}), ...(identityId ? { identityId } : {}) })
      .map((b) => ({
        channel: b.channel,
        identityId: b.identity_id,
        peerId: b.peer_id,
        directory: b.directory,
        updatedAt: b.updated_at,
      }));
    store.close();
    if (useJson) outputJson({ items });
    else for (const item of items) console.log(`${item.channel}/${item.identityId} ${item.peerId} -> ${item.directory}`);
  });

bindings
  .command("set")
  .requiredOption("--channel <channel>", "telegram|slack")
  .requiredOption("--identity <id>", "Identity id")
  .requiredOption("--peer <peerId>", "Peer id")
  .requiredOption("--dir <directory>", "Directory")
  .description("Set a binding")
  .action((opts: { channel: string; identity: string; peer: string; dir: string }) => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    const store = new BridgeStore(config.dbPath);
    const channelRaw = opts.channel.trim().toLowerCase();
    if (channelRaw !== "telegram" && channelRaw !== "slack") outputError("Invalid channel");
    const identityId = normalizeIdentityId(opts.identity);
    const peerId = opts.peer.trim();
    const directory = opts.dir.trim();
    if (!peerId || !directory) outputError("peer and dir are required");
    store.upsertBinding(channelRaw as ChannelName, identityId, peerId, directory);
    store.deleteSession(channelRaw as ChannelName, identityId, peerId);
    store.close();
    if (useJson) outputJson({ success: true });
    else console.log("Binding saved.");
  });

bindings
  .command("clear")
  .requiredOption("--channel <channel>", "telegram|slack")
  .requiredOption("--identity <id>", "Identity id")
  .requiredOption("--peer <peerId>", "Peer id")
  .description("Clear a binding")
  .action((opts: { channel: string; identity: string; peer: string }) => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    const store = new BridgeStore(config.dbPath);
    const channelRaw = opts.channel.trim().toLowerCase();
    if (channelRaw !== "telegram" && channelRaw !== "slack") outputError("Invalid channel");
    const identityId = normalizeIdentityId(opts.identity);
    const peerId = opts.peer.trim();
    const ok = store.deleteBinding(channelRaw as ChannelName, identityId, peerId);
    store.deleteSession(channelRaw as ChannelName, identityId, peerId);
    store.close();
    if (useJson) outputJson({ success: ok });
    else console.log(ok ? "Binding removed." : "Binding not found.");
    process.exit(ok ? 0 : 1);
  });

// -----------------------------------------------------------------------------
// Send helper
// -----------------------------------------------------------------------------

program
  .command("send")
  .description("Send a test message")
  .requiredOption("--channel <channel>", "telegram or slack")
  .requiredOption("--identity <id>", "Identity id")
  .requiredOption("--to <recipient>", "Recipient ID (chat ID or peerId)")
  .requiredOption("--message <text>", "Message text to send")
  .action(async (opts: { channel: string; identity: string; to: string; message: string }) => {
    const useJson = program.opts().json;
    const channelRaw = opts.channel.trim().toLowerCase();
    if (channelRaw !== "telegram" && channelRaw !== "slack") {
      outputError("Invalid channel. Must be 'telegram' or 'slack'.");
    }

    const config = loadConfig(process.env, { requireOpencode: false });
    const identityId = normalizeIdentityId(opts.identity);
    const to = opts.to.trim();
    const message = opts.message;

    try {
      if (channelRaw === "telegram") {
        const bot = config.telegramBots.find((b) => b.id === identityId);
        if (!bot) throw new Error(`Telegram identity not found: ${identityId}`);
        const tg = new Bot(bot.token);
        await tg.api.sendMessage(Number(to), message);
      } else {
        const app = config.slackApps.find((a) => a.id === identityId);
        if (!app) throw new Error(`Slack identity not found: ${identityId}`);
        const web = new WebClient(app.botToken);
        const peer = parseSlackPeerId(to);
        if (!peer.channelId) throw new Error("Invalid recipient for Slack.");
        await web.chat.postMessage({
          channel: peer.channelId,
          text: message,
          ...(peer.threadTs ? { thread_ts: peer.threadTs } : {}),
        } as any);
      }

      if (useJson) outputJson({ success: true });
      else console.log("Message sent.");
      process.exit(0);
    } catch (error) {
      if (useJson) outputJson({ success: false, error: String(error) });
      else console.error(`Failed to send message: ${String(error)}`);
      process.exit(1);
    }
  });

program.action(() => {
  program.outputHelp();
});

program.parseAsync(process.argv).catch((error) => {
  const useJson = program.opts().json;
  if (useJson) outputJson({ error: String(error) });
  else console.error(error);
  process.exitCode = 1;
});
