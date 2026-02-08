#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { Command } from "commander";

import { startBridge, type BridgeReporter } from "./bridge.js";
import {
  loadConfig,
  normalizeWhatsAppId,
  readConfigFile,
  writeConfigFile,
  type ChannelName,
  type OwpenbotConfigFile,
} from "./config.js";
import { BridgeStore } from "./db.js";
import { createLogger } from "./logger.js";
import { createClient } from "./opencode.js";
import { parseSlackPeerId } from "./slack.js";
import { truncateText } from "./text.js";
import { loginWhatsApp, unpairWhatsApp } from "./whatsapp.js";
import { hasWhatsAppCreds } from "./whatsapp-session.js";

declare const __OWPENBOT_VERSION__: string | undefined;

const VERSION = (() => {
  if (typeof __OWPENBOT_VERSION__ === "string" && __OWPENBOT_VERSION__.trim()) {
    return __OWPENBOT_VERSION__.trim();
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

// -----------------------------------------------------------------------------
// JSON output helpers
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// App logger and console reporter for start command
// -----------------------------------------------------------------------------

function createAppLogger(config: ReturnType<typeof loadConfig>) {
  return createLogger(config.logLevel, { logFile: config.logFile });
}

function createConsoleReporter(): BridgeReporter {
  const formatChannel = (channel: ChannelName) =>
    channel === "whatsapp" ? "WhatsApp" : channel === "telegram" ? "Telegram" : "Slack";
  const formatPeer = (channel: ChannelName, peerId: string, fromMe?: boolean) => {
    const base = channel === "whatsapp" ? normalizeWhatsAppId(peerId) : peerId;
    return fromMe ? `${base} (me)` : base;
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
    onInbound({ channel, peerId, text, fromMe }) {
      const prefix = `[${formatChannel(channel)}] ${formatPeer(channel, peerId, fromMe)} >`;
      printBlock(prefix, text);
    },
    onOutbound({ channel, peerId, text, kind }) {
      const marker = kind === "reply" ? "<" : kind === "tool" ? "*" : "!";
      const prefix = `[${formatChannel(channel)}] ${formatPeer(channel, peerId)} ${marker}`;
      printBlock(prefix, text);
    },
  };
}

// -----------------------------------------------------------------------------
// Config helpers
// -----------------------------------------------------------------------------

function updateConfig(configPath: string, updater: (cfg: OwpenbotConfigFile) => OwpenbotConfigFile) {
  const { config } = readConfigFile(configPath);
  const base = config ?? { version: 1 };
  const next = updater(base);
  next.version = next.version ?? 1;
  writeConfigFile(configPath, next);
  return next;
}

function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown {
  const keys = keyPath.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, keyPath: string, value: unknown): void {
  const keys = keyPath.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] === undefined || current[key] === null || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

function parseConfigValue(value: string): unknown {
  // Try to parse as JSON first (for arrays, objects, booleans, numbers)
  try {
    return JSON.parse(value);
  } catch {
    // Return as string if not valid JSON
    return value;
  }
}

// -----------------------------------------------------------------------------
// Start command
// -----------------------------------------------------------------------------

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
  // Avoid noisy startup output when running under openwrk/desktop (stdio is
  // usually piped). Keep the hint for interactive CLI usage.
  if (process.stdout.isTTY) {
    reporter.onStatus?.("Commands: owpenwork whatsapp login, owpenwork slack status, owpenwork pairing list, owpenwork status");
  }

  const shutdown = async () => {
    logger.info("shutting down");
    await bridge.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// -----------------------------------------------------------------------------
// QR code generation for non-interactive use
// -----------------------------------------------------------------------------

async function getWhatsAppQr(config: ReturnType<typeof loadConfig>, format: "ascii" | "base64"): Promise<string> {
  const { createWhatsAppSocket, closeWhatsAppSocket } = await import("./whatsapp-session.js");
  const logger = createAppLogger(config);
  
  return new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error("Timeout waiting for QR code"));
      }
    }, 30000);

    void createWhatsAppSocket({
      authDir: config.whatsappAuthDir,
      logger,
      printQr: false,
      onQr: (qr) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        
        if (format === "base64") {
          resolve(Buffer.from(qr).toString("base64"));
        } else {
          // Generate ASCII QR using qrcode-terminal's internal logic
          // For simplicity, return the raw QR data - consumers can render it
          resolve(qr);
        }
      },
    }).then((sock) => {
      // Close socket after getting QR or on timeout
      setTimeout(() => {
        closeWhatsAppSocket(sock);
      }, resolved ? 500 : 30500);
    }).catch((err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

// -----------------------------------------------------------------------------
// Operator TUI (TTY-first, talks to local API)
// -----------------------------------------------------------------------------

type OperatorApiTarget = {
  baseUrl: string;
  headers: Record<string, string>;
  mode: "direct" | "openwork";
};

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function resolveOperatorTarget(options: {
  url?: string;
  openworkUrl?: string;
  token?: string;
  hostToken?: string;
}): OperatorApiTarget {
  const openworkUrl = options.openworkUrl?.trim();
  if (openworkUrl) {
    const token =
      options.token?.trim() ||
      process.env.OPENWORK_TOKEN?.trim() ||
      process.env.OPENWRK_OPENWORK_TOKEN?.trim() ||
      "";
    if (!token) {
      throw new Error("--token is required when using --openwork-url (or set OPENWORK_TOKEN)");
    }

    const hostToken =
      options.hostToken?.trim() ||
      process.env.OPENWORK_HOST_TOKEN?.trim() ||
      process.env.OPENWRK_OPENWORK_HOST_TOKEN?.trim() ||
      "";

    const base = normalizeBaseUrl(openworkUrl);
    const baseUrl = base.endsWith("/owpenbot") ? base : `${base}/owpenbot`;
    return {
      baseUrl,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(hostToken ? { "X-OpenWork-Host-Token": hostToken } : {}),
      },
      mode: "openwork",
    };
  }

  const port = process.env.OWPENBOT_HEALTH_PORT?.trim() || "3005";
  const baseUrl = normalizeBaseUrl(options.url?.trim() || `http://127.0.0.1:${port}`);
  return { baseUrl, headers: {}, mode: "direct" };
}

async function fetchOwpenbotJson(target: OperatorApiTarget, pathname: string, init?: RequestInit) {
  const url = `${target.baseUrl}${pathname.startsWith("/") ? "" : "/"}${pathname}`;
  const headers = {
    ...target.headers,
    ...(init?.headers ?? {}),
  } as Record<string, string>;
  const res = await fetch(url, {
    ...init,
    headers,
  });
  const text = await res.text();
  let payload: any = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!res.ok) {
    const message = typeof payload?.error === "string" ? payload.error : text.trim() || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return payload;
}

function formatYesNo(value: unknown): string {
  return value ? "yes" : "no";
}

async function runOperatorTui(options: { url?: string; openworkUrl?: string; token?: string; hostToken?: string }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("tui requires an interactive TTY");
  }

  const target = resolveOperatorTarget(options);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const pause = async () => {
    await rl.question("\nPress Enter to continue...");
  };

  try {
    // Initial probe
    await fetchOwpenbotJson(target, "/health");

    while (true) {
      console.clear();
      const health = await fetchOwpenbotJson(target, "/health");
      const opencode = health?.opencode ?? {};
      const channels = health?.channels ?? {};
      const config = health?.config ?? {};

      console.log(`Owpenbot Operator TUI (${target.mode})`);
      console.log(`API: ${target.baseUrl}`);
      console.log(`OpenCode healthy: ${formatYesNo(opencode.healthy)}`);
      console.log(`Telegram adapter: ${formatYesNo(channels.telegram)}`);
      console.log(`WhatsApp adapter: ${formatYesNo(channels.whatsapp)}`);
      console.log(`Slack adapter: ${formatYesNo(channels.slack)}`);
      console.log(`Groups enabled: ${formatYesNo(config.groupsEnabled)}`);
      console.log("");
      console.log("1) Refresh");
      console.log("2) Show WhatsApp QR (ASCII)");
      console.log("3) Toggle WhatsApp enabled");
      console.log("4) Toggle groups enabled");
      console.log("5) Set Telegram token");
      console.log("6) Set Slack tokens");
      console.log("7) List bindings");
      console.log("8) Set binding");
      console.log("9) Clear binding");
      console.log("0) Exit");

      const choice = (await rl.question("\nSelect> ")).trim().toLowerCase();
      if (choice === "0" || choice === "q" || choice === "quit" || choice === "exit") {
        return;
      }

      try {
        if (choice === "1" || choice === "r" || choice === "refresh") {
          continue;
        }

        if (choice === "2") {
          const qr = await fetchOwpenbotJson(target, "/whatsapp/qr?format=ascii");
          console.clear();
          const out = typeof qr?.qr === "string" ? qr.qr : JSON.stringify(qr, null, 2);
          process.stdout.write(`${out}\n`);
          await pause();
          continue;
        }

        if (choice === "3") {
          const current = await fetchOwpenbotJson(target, "/config/whatsapp-enabled");
          const enabled = Boolean(current?.enabled);
          const next = await fetchOwpenbotJson(target, "/config/whatsapp-enabled", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: !enabled }),
          });
          console.log(`\nWhatsApp enabled: ${formatYesNo(!enabled)}`);
          if (next?.error) console.log(`Error: ${String(next.error)}`);
          await pause();
          continue;
        }

        if (choice === "4") {
          const current = await fetchOwpenbotJson(target, "/config/groups");
          const enabled = Boolean(current?.groupsEnabled);
          const next = await fetchOwpenbotJson(target, "/config/groups", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: !enabled }),
          });
          console.log(`\nGroups enabled: ${formatYesNo(!enabled)}`);
          if (next?.error) console.log(`Error: ${String(next.error)}`);
          await pause();
          continue;
        }

        if (choice === "5") {
          const token = (await rl.question("Telegram bot token> ")).trim();
          if (!token) {
            await pause();
            continue;
          }
          const next = await fetchOwpenbotJson(target, "/config/telegram-token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
          });
          console.log("\nTelegram updated.");
          if (next?.telegram?.error) console.log(`Error: ${String(next.telegram.error)}`);
          await pause();
          continue;
        }

        if (choice === "6") {
          const botToken = (await rl.question("Slack bot token> ")).trim();
          const appToken = (await rl.question("Slack app token> ")).trim();
          if (!botToken || !appToken) {
            await pause();
            continue;
          }
          const next = await fetchOwpenbotJson(target, "/config/slack-tokens", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ botToken, appToken }),
          });
          console.log("\nSlack updated.");
          if (next?.slack?.error) console.log(`Error: ${String(next.slack.error)}`);
          await pause();
          continue;
        }

        if (choice === "7") {
          const bindings = await fetchOwpenbotJson(target, "/bindings");
          console.clear();
          console.log("Bindings:\n");
          const items = Array.isArray(bindings?.items) ? bindings.items : [];
          if (!items.length) {
            console.log("(none)");
          } else {
            for (const item of items) {
              const channel = String(item.channel ?? "");
              const peerId = String(item.peerId ?? "");
              const directory = String(item.directory ?? "");
              console.log(`${channel} ${peerId} -> ${directory}`);
            }
          }
          await pause();
          continue;
        }

        if (choice === "8") {
          const channel = (await rl.question("Channel (whatsapp|telegram|slack)> ")).trim();
          const peerId = (await rl.question("Peer ID> ")).trim();
          const directory = (await rl.question("OpenCode directory path> ")).trim();
          if (!channel || !peerId || !directory) {
            await pause();
            continue;
          }
          await fetchOwpenbotJson(target, "/bindings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ channel, peerId, directory }),
          });
          console.log("\nBinding saved.");
          await pause();
          continue;
        }

        if (choice === "9") {
          const channel = (await rl.question("Channel (whatsapp|telegram|slack)> ")).trim();
          const peerId = (await rl.question("Peer ID> ")).trim();
          if (!channel || !peerId) {
            await pause();
            continue;
          }
          await fetchOwpenbotJson(target, "/bindings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ channel, peerId, directory: "" }),
          });
          console.log("\nBinding cleared.");
          await pause();
          continue;
        }

        console.log("\nUnknown choice.");
        await pause();
      } catch (error) {
        console.log(`\nError: ${error instanceof Error ? error.message : String(error)}`);
        await pause();
      }
    }
  } finally {
    rl.close();
  }
}

// -----------------------------------------------------------------------------
// Commander setup
// -----------------------------------------------------------------------------

const program = new Command();

program
  .name("owpenbot")
  .version(VERSION)
  .description("OpenCode WhatsApp + Telegram + Slack bridge")
  .option("--json", "Output in JSON format", false);

// -----------------------------------------------------------------------------
// start command
// -----------------------------------------------------------------------------

program
  .command("start")
  .description("Start the bridge")
  .argument("[path]", "OpenCode workspace path")
  .option("--opencode-url <url>", "OpenCode server URL")
  .action((pathArg?: string, options?: { opencodeUrl?: string }) => runStart(pathArg, options));

program
  .command("serve")
  .description("Start the bridge (headless)")
  .argument("[path]", "OpenCode workspace path")
  .option("--opencode-url <url>", "OpenCode server URL")
  .action((pathArg?: string, options?: { opencodeUrl?: string }) => runStart(pathArg, options));

// -----------------------------------------------------------------------------
// health command
// -----------------------------------------------------------------------------

program
  .command("health")
  .description("Check bridge health (exit 0 if healthy, 1 if not)")
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
          channels: {
            whatsapp: hasWhatsAppCreds(config.whatsappAuthDir) ? "linked" : "unlinked",
            telegram: config.telegramToken ? "configured" : "unconfigured",
            slack: config.slackBotToken && config.slackAppToken ? "configured" : "unconfigured",
          },
        });
      } else {
        console.log(`Healthy: ${healthy ? "yes" : "no"}`);
        console.log(`OpenCode URL: ${config.opencodeUrl}`);
      }
      
      process.exit(healthy ? 0 : 1);
    } catch (error) {
      if (useJson) {
        outputJson({
          healthy: false,
          error: String(error),
          opencodeUrl: config.opencodeUrl,
          channels: {
            whatsapp: hasWhatsAppCreds(config.whatsappAuthDir) ? "linked" : "unlinked",
            telegram: config.telegramToken ? "configured" : "unconfigured",
            slack: config.slackBotToken && config.slackAppToken ? "configured" : "unconfigured",
          },
        });
      } else {
        console.log("Healthy: no");
        console.log(`Error: ${String(error)}`);
      }
      process.exit(1);
    }
  });

// -----------------------------------------------------------------------------
// status command
// -----------------------------------------------------------------------------

program
  .command("status")
  .description("Show WhatsApp, Telegram, and OpenCode status")
  .action(async () => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    const whatsappLinked = hasWhatsAppCreds(config.whatsappAuthDir);
    
    if (useJson) {
      outputJson({
        config: config.configPath,
        healthPort: config.healthPort ?? null,
        whatsapp: {
          linked: whatsappLinked,
          dmPolicy: config.whatsappDmPolicy,
          selfChatMode: config.whatsappSelfChatMode,
          authDir: config.whatsappAuthDir,
        },
        telegram: {
          configured: Boolean(config.telegramToken),
          enabled: config.telegramEnabled,
        },
        slack: {
          configured: Boolean(config.slackBotToken && config.slackAppToken),
          enabled: config.slackEnabled,
        },
        opencode: {
          url: config.opencodeUrl,
          directory: config.opencodeDirectory,
        },
      });
    } else {
      console.log(`Config: ${config.configPath}`);
      console.log(`Health port: ${config.healthPort ?? "(not set)"}`);
      console.log(`WhatsApp linked: ${whatsappLinked ? "yes" : "no"}`);
      console.log(`WhatsApp DM policy: ${config.whatsappDmPolicy}`);
      console.log(`Telegram configured: ${config.telegramToken ? "yes" : "no"}`);
      console.log(`Slack configured: ${config.slackBotToken && config.slackAppToken ? "yes" : "no"}`);
      console.log(`Auth dir: ${config.whatsappAuthDir}`);
      console.log(`OpenCode URL: ${config.opencodeUrl}`);
    }
  });

// -----------------------------------------------------------------------------
// tui command
// -----------------------------------------------------------------------------

program
  .command("tui")
  .description("Interactive operator UI (requires a running owpenbot health API)")
  .option("--url <url>", "Owpenbot API base URL (default: http://127.0.0.1:$OWPENBOT_HEALTH_PORT)")
  .option("--openwork-url <url>", "OpenWork server URL to proxy owpenbot through (uses /owpenbot/*)")
  .option("--token <token>", "OpenWork client token (required with --openwork-url; or set OPENWORK_TOKEN)")
  .option("--host-token <token>", "OpenWork host token (required for admin actions; or use an owner token)")
  .action(async (opts: { url?: string; openworkUrl?: string; token?: string; hostToken?: string }) => {
    if (program.opts().json) {
      outputError("tui does not support --json (use health/status/config commands instead)");
    }
    try {
      await runOperatorTui(opts);
    } catch (error) {
      outputError(error instanceof Error ? error.message : String(error));
    }
  });

// -----------------------------------------------------------------------------
// config subcommand
// -----------------------------------------------------------------------------

const configCmd = program.command("config").description("Manage configuration");

configCmd
  .command("get")
  .argument("[key]", "Config key to get (dot notation, e.g., channels.whatsapp.dmPolicy)")
  .description("Get config value(s)")
  .action((key?: string) => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    const { config: configFile } = readConfigFile(config.configPath);
    
    if (key) {
      const value = getNestedValue(configFile as Record<string, unknown>, key);
      if (useJson) {
        outputJson({ [key]: value });
      } else {
        if (value === undefined) {
          console.log(`${key}: (not set)`);
        } else if (typeof value === "object") {
          console.log(`${key}: ${JSON.stringify(value, null, 2)}`);
        } else {
          console.log(`${key}: ${value}`);
        }
      }
    } else {
      if (useJson) {
        outputJson(configFile);
      } else {
        console.log(JSON.stringify(configFile, null, 2));
      }
    }
  });

configCmd
  .command("set")
  .argument("<key>", "Config key to set (dot notation)")
  .argument("<value>", "Value to set (JSON for arrays/objects)")
  .description("Set config value")
  .action((key: string, value: string) => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    
    const parsedValue = parseConfigValue(value);
    const updated = updateConfig(config.configPath, (cfg) => {
      const next = { ...cfg } as Record<string, unknown>;
      setNestedValue(next, key, parsedValue);
      return next as OwpenbotConfigFile;
    });
    
    if (useJson) {
      outputJson({ success: true, key, value: parsedValue, config: updated });
    } else {
      console.log(`Set ${key} = ${JSON.stringify(parsedValue)}`);
    }
  });

// -----------------------------------------------------------------------------
// whatsapp subcommand
// -----------------------------------------------------------------------------

const whatsapp = program.command("whatsapp").description("WhatsApp helpers");

whatsapp
  .command("status")
  .description("Show WhatsApp status")
  .action(() => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    const linked = hasWhatsAppCreds(config.whatsappAuthDir);
    
    if (useJson) {
      outputJson({
        linked,
        dmPolicy: config.whatsappDmPolicy,
        selfChatMode: config.whatsappSelfChatMode,
        authDir: config.whatsappAuthDir,
        accountId: config.whatsappAccountId,
        allowFrom: [...config.whatsappAllowFrom],
      });
    } else {
      console.log(`WhatsApp linked: ${linked ? "yes" : "no"}`);
      console.log(`DM policy: ${config.whatsappDmPolicy}`);
      console.log(`Self chat mode: ${config.whatsappSelfChatMode ? "yes" : "no"}`);
      console.log(`Auth dir: ${config.whatsappAuthDir}`);
    }
  });

whatsapp
  .command("login")
  .description("Login to WhatsApp via QR code")
  .action(async () => {
    const config = loadConfig(process.env, { requireOpencode: false });
    await loginWhatsApp(config, createAppLogger(config), { onStatus: console.log });
  });

whatsapp
  .command("logout")
  .description("Logout of WhatsApp and clear auth state")
  .action(() => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    unpairWhatsApp(config, createAppLogger(config));
    
    if (useJson) {
      outputJson({ success: true, message: "WhatsApp auth cleared" });
    } else {
      console.log("WhatsApp auth cleared.");
    }
  });

whatsapp
  .command("qr")
  .description("Get WhatsApp QR code non-interactively")
  .option("--format <format>", "Output format: ascii or base64", "ascii")
  .action(async (opts) => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    const format = opts.format as "ascii" | "base64";
    
    if (hasWhatsAppCreds(config.whatsappAuthDir)) {
      if (useJson) {
        outputJson({ error: "WhatsApp already linked. Use 'whatsapp logout' first." });
      } else {
        console.log("WhatsApp already linked. Use 'whatsapp logout' first.");
      }
      process.exit(1);
    }
    
    try {
      const qr = await getWhatsAppQr(config, format);
      
      if (useJson) {
        outputJson({ qr, format });
      } else {
        if (format === "ascii") {
          // Use qrcode-terminal to print ASCII QR
          const qrcode = await import("qrcode-terminal");
          qrcode.default.generate(qr, { small: true });
        } else {
          console.log(qr);
        }
      }
    } catch (error) {
      if (useJson) {
        outputJson({ error: String(error) });
      } else {
        console.error(`Failed to get QR code: ${String(error)}`);
      }
      process.exit(1);
    }
  });

// -----------------------------------------------------------------------------
// telegram subcommand
// -----------------------------------------------------------------------------

const telegram = program.command("telegram").description("Telegram helpers");

telegram
  .command("status")
  .description("Show Telegram status")
  .action(() => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    
    if (useJson) {
      outputJson({
        configured: Boolean(config.telegramToken),
        enabled: config.telegramEnabled,
        hasToken: Boolean(config.telegramToken),
      });
    } else {
      console.log(`Telegram configured: ${config.telegramToken ? "yes" : "no"}`);
      console.log(`Telegram enabled: ${config.telegramEnabled ? "yes" : "no"}`);
    }
  });

telegram
  .command("set-token")
  .argument("<token>", "Telegram bot token")
  .description("Set Telegram bot token")
  .action((token: string) => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    
    updateConfig(config.configPath, (cfg) => {
      const next = { ...cfg } as OwpenbotConfigFile;
      next.channels = next.channels ?? {};
      next.channels.telegram = {
        token,
        enabled: true,
      };
      return next;
    });
    
    if (useJson) {
      outputJson({ success: true, message: "Telegram token saved" });
    } else {
      console.log("Telegram token saved.");
    }
  });

// -----------------------------------------------------------------------------
// slack subcommand
// -----------------------------------------------------------------------------

const slack = program.command("slack").description("Slack helpers");

slack
  .command("status")
  .description("Show Slack status")
  .action(() => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    const configured = Boolean(config.slackBotToken && config.slackAppToken);

    if (useJson) {
      outputJson({
        configured,
        enabled: config.slackEnabled,
        hasBotToken: Boolean(config.slackBotToken),
        hasAppToken: Boolean(config.slackAppToken),
      });
    } else {
      console.log(`Slack configured: ${configured ? "yes" : "no"}`);
      console.log(`Slack enabled: ${config.slackEnabled ? "yes" : "no"}`);
    }
  });

slack
  .command("set-tokens")
  .argument("<botToken>", "Slack bot token (xoxb-...)")
  .argument("<appToken>", "Slack app token (xapp-...)")
  .description("Set Slack bot/app tokens")
  .action((botToken: string, appToken: string) => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });

    updateConfig(config.configPath, (cfg) => {
      const next = { ...cfg } as OwpenbotConfigFile;
      next.channels = next.channels ?? {};
      next.channels.slack = {
        botToken,
        appToken,
        enabled: true,
      };
      return next;
    });

    if (useJson) {
      outputJson({ success: true, message: "Slack tokens saved" });
    } else {
      console.log("Slack tokens saved.");
    }
  });

// -----------------------------------------------------------------------------
// pairing subcommand
// -----------------------------------------------------------------------------

const pairing = program.command("pairing").description("Pairing requests");

pairing
  .command("list")
  .description("List pending pairing requests")
  .action(() => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    const store = new BridgeStore(config.dbPath);
    store.prunePairingRequests();
    const requests = store.listPairingRequests();
    store.close();
    
    if (useJson) {
      outputJson(
        requests.map((r) => ({
          code: r.code,
          peerId: r.peer_id,
          channel: r.channel,
          createdAt: new Date(r.created_at).toISOString(),
          expiresAt: new Date(r.expires_at).toISOString(),
        })),
      );
    } else {
      if (!requests.length) {
        console.log("No pending pairing requests.");
      } else {
        for (const request of requests) {
          console.log(`${request.code} ${request.channel} ${request.peer_id}`);
        }
      }
    }
  });

pairing
  .command("approve")
  .argument("<code>", "Pairing code to approve")
  .description("Approve a pairing request")
  .action((code: string) => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    const store = new BridgeStore(config.dbPath);
    const request = store.approvePairingRequest("whatsapp", code.trim());
    
    if (!request) {
      store.close();
      if (useJson) {
        outputJson({ success: false, error: "Pairing code not found or expired" });
      } else {
        console.log("Pairing code not found or expired.");
      }
      process.exit(1);
    }
    
    store.allowPeer("whatsapp", request.peer_id);
    store.close();
    
    if (useJson) {
      outputJson({ success: true, peerId: request.peer_id, channel: request.channel });
    } else {
      console.log(`Approved ${request.peer_id}`);
    }
  });

pairing
  .command("deny")
  .argument("<code>", "Pairing code to deny")
  .description("Deny a pairing request")
  .action((code: string) => {
    const useJson = program.opts().json;
    const config = loadConfig(process.env, { requireOpencode: false });
    const store = new BridgeStore(config.dbPath);
    const ok = store.denyPairingRequest("whatsapp", code.trim());
    store.close();
    
    if (useJson) {
      outputJson({ success: ok, message: ok ? "Pairing request removed" : "Pairing code not found" });
    } else {
      console.log(ok ? "Removed pairing request." : "Pairing code not found.");
    }
    
    process.exit(ok ? 0 : 1);
  });

// -----------------------------------------------------------------------------
// Legacy commands for backwards compatibility
// -----------------------------------------------------------------------------

program
  .command("qr")
  .description("Print a WhatsApp QR code to pair (alias for whatsapp qr)")
  .action(async () => {
    const config = loadConfig(process.env, { requireOpencode: false });
    await loginWhatsApp(config, createAppLogger(config), { onStatus: console.log });
  });

program
  .command("unpair")
  .description("Clear WhatsApp pairing data (alias for whatsapp logout)")
  .action(() => {
    const config = loadConfig(process.env, { requireOpencode: false });
    unpairWhatsApp(config, createAppLogger(config));
  });

// login subcommand for backwards compatibility
const login = program.command("login").description("Link channels (legacy)");

login
  .command("whatsapp")
  .description("Login to WhatsApp via QR code")
  .action(async () => {
    const config = loadConfig(process.env, { requireOpencode: false });
    await loginWhatsApp(config, createAppLogger(config), { onStatus: console.log });
  });

login
  .command("telegram")
  .option("--token <token>", "Telegram bot token")
  .description("Save Telegram bot token")
  .action((opts) => {
    if (!opts.token) {
      console.error("Error: --token is required");
      process.exit(1);
    }
    const config = loadConfig(process.env, { requireOpencode: false });
    updateConfig(config.configPath, (cfg) => {
      const next = { ...cfg } as OwpenbotConfigFile;
      next.channels = next.channels ?? {};
      next.channels.telegram = {
        token: opts.token,
        enabled: true,
      };
      return next;
    });
    console.log("Telegram token saved.");
  });

// pairing-code (legacy alias)
program
  .command("pairing-code")
  .description("List pending pairing codes (alias for pairing list)")
  .action(() => {
    const config = loadConfig(process.env, { requireOpencode: false });
    const store = new BridgeStore(config.dbPath);
    store.prunePairingRequests();
    const requests = store.listPairingRequests("whatsapp");
    if (!requests.length) {
      console.log("No pending pairing requests.");
    } else {
      for (const request of requests) {
        console.log(`${request.code} ${request.peer_id}`);
      }
    }
    store.close();
  });

// -----------------------------------------------------------------------------
// send command
// -----------------------------------------------------------------------------

program
  .command("send")
  .description("Send a test message")
  .requiredOption("--channel <channel>", "Channel: whatsapp, telegram, or slack")
  .requiredOption("--to <recipient>", "Recipient ID (phone number or chat ID)")
  .requiredOption("--message <text>", "Message text to send")
  .action(async (opts) => {
    const useJson = program.opts().json;
    const channel = opts.channel as string;
    const to = opts.to as string;
    const message = opts.message as string;

    if (channel !== "whatsapp" && channel !== "telegram" && channel !== "slack") {
      if (useJson) {
        outputJson({
          success: false,
          error: `Invalid channel: ${channel}. Must be 'whatsapp', 'telegram', or 'slack'.`,
        });
      } else {
        console.error(`Error: Invalid channel '${channel}'. Must be 'whatsapp', 'telegram', or 'slack'.`);
      }
      process.exit(1);
    }

    const config = loadConfig(process.env, { requireOpencode: false });
    const logger = createAppLogger(config);

    try {
      if (channel === "whatsapp") {
        const { createWhatsAppAdapter } = await import("./whatsapp.js");
        const adapter = createWhatsAppAdapter(config, logger, async () => {}, { printQr: false });
        await adapter.start();
        
        // Format the recipient ID for WhatsApp
        let peerId = to.trim();
        if (!peerId.includes("@")) {
          // Remove + prefix if present and add WhatsApp suffix
          const cleaned = peerId.startsWith("+") ? peerId.slice(1) : peerId;
          peerId = `${cleaned}@s.whatsapp.net`;
        }
        
        await adapter.sendText(peerId, message);
        await adapter.stop();
        
        if (useJson) {
          outputJson({ success: true, channel, to: peerId, message });
        } else {
          console.log(`Message sent to ${peerId} via WhatsApp`);
        }
      } else if (channel === "telegram") {
        const { createTelegramAdapter } = await import("./telegram.js");
        const adapter = createTelegramAdapter(config, logger, async () => {});
        // Note: Telegram adapter's start() begins long-polling, we just need to send
        // Use the bot API directly for a one-shot send
        const { Bot } = await import("grammy");
        if (!config.telegramToken) {
          throw new Error("Telegram bot token not configured. Use 'owpenbot telegram set-token <token>' first.");
        }
        const bot = new Bot(config.telegramToken);
        await bot.api.sendMessage(Number(to), message);
        
        if (useJson) {
          outputJson({ success: true, channel, to, message });
        } else {
          console.log(`Message sent to ${to} via Telegram`);
        }
      } else {
        // Slack
        const { WebClient } = await import("@slack/web-api");
        if (!config.slackBotToken) {
          throw new Error("Slack bot token not configured. Use 'owpenbot slack set-tokens <bot> <app>' first.");
        }
        const web = new WebClient(config.slackBotToken);
        const peer = parseSlackPeerId(to);
        if (!peer.channelId) {
          throw new Error("Invalid recipient for Slack. Use a channel ID (C..., D...) or encoded peerId (C...|threadTs)");
        }
        await web.chat.postMessage({
          channel: peer.channelId,
          text: message,
          ...(peer.threadTs ? { thread_ts: peer.threadTs } : {}),
        });

        if (useJson) {
          outputJson({ success: true, channel, to, message });
        } else {
          console.log(`Message sent to ${to} via Slack`);
        }
      }
      process.exit(0);
    } catch (error) {
      if (useJson) {
        outputJson({ success: false, error: String(error) });
      } else {
        console.error(`Failed to send message: ${String(error)}`);
      }
      process.exit(1);
    }
  });

// -----------------------------------------------------------------------------
// Default action (no subcommand)
// -----------------------------------------------------------------------------

program.action(() => {
  program.outputHelp();
});

// -----------------------------------------------------------------------------
// Parse and run
// -----------------------------------------------------------------------------

program.parseAsync(process.argv).catch((error) => {
  const useJson = program.opts().json;
  if (useJson) {
    outputJson({ error: String(error) });
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
