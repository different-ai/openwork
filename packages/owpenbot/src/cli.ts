#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

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
import { truncateText } from "./text.js";
import { loginWhatsApp, unpairWhatsApp } from "./whatsapp.js";
import { hasWhatsAppCreds } from "./whatsapp-session.js";

const VERSION = "0.1.16";

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
  const formatChannel = (channel: ChannelName) => (channel === "whatsapp" ? "WhatsApp" : "Telegram");
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

async function runStart(pathOverride?: string) {
  if (pathOverride?.trim()) {
    process.env.OPENCODE_DIRECTORY = pathOverride.trim();
  }
  const config = loadConfig();
  const logger = createAppLogger(config);
  const reporter = createConsoleReporter();
  if (!process.env.OPENCODE_DIRECTORY) {
    process.env.OPENCODE_DIRECTORY = config.opencodeDirectory;
  }
  const bridge = await startBridge(config, logger, reporter);
  reporter.onStatus?.("Commands: owpenwork whatsapp login, owpenwork pairing list, owpenwork status");

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
// Commander setup
// -----------------------------------------------------------------------------

const program = new Command();

program
  .name("owpenbot")
  .version(VERSION)
  .description("OpenCode WhatsApp + Telegram bridge")
  .option("--json", "Output in JSON format", false);

// -----------------------------------------------------------------------------
// start command
// -----------------------------------------------------------------------------

program
  .command("start")
  .description("Start the bridge")
  .argument("[path]", "OpenCode workspace path")
  .action((pathArg?: string) => runStart(pathArg));

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
        opencode: {
          url: config.opencodeUrl,
          directory: config.opencodeDirectory,
        },
      });
    } else {
      console.log(`Config: ${config.configPath}`);
      console.log(`WhatsApp linked: ${whatsappLinked ? "yes" : "no"}`);
      console.log(`WhatsApp DM policy: ${config.whatsappDmPolicy}`);
      console.log(`Telegram configured: ${config.telegramToken ? "yes" : "no"}`);
      console.log(`Auth dir: ${config.whatsappAuthDir}`);
      console.log(`OpenCode URL: ${config.opencodeUrl}`);
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
// logs command
// -----------------------------------------------------------------------------

program
  .command("logs")
  .description("View recent logs")
  .option("--tail <lines>", "Number of lines to show", "50")
  .option("--follow, -f", "Follow log output (not implemented)")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const config = loadConfig(process.env, { requireOpencode: false });
    const useJson = opts.json || program.opts().json;
    const tailLines = Number.parseInt(opts.tail, 10) || 50;

    if (!fs.existsSync(config.logFile)) {
      if (useJson) {
        outputJson({ error: "Log file not found", path: config.logFile, lines: [] });
      } else {
        console.log(`Log file not found: ${config.logFile}`);
      }
      process.exit(1);
    }

    try {
      const content = fs.readFileSync(config.logFile, "utf-8");
      const allLines = content.split("\n").filter(Boolean);
      const lines = allLines.slice(-tailLines);

      if (useJson) {
        // Try to parse each line as JSON for structured output
        const parsed = lines.map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { raw: line };
          }
        });
        outputJson({ path: config.logFile, count: lines.length, lines: parsed });
      } else {
        console.log(`Log file: ${config.logFile}`);
        console.log(`Showing last ${lines.length} lines:\n`);
        for (const line of lines) {
          console.log(line);
        }
      }
    } catch (error) {
      if (useJson) {
        outputJson({ error: String(error), path: config.logFile });
      } else {
        console.error(`Failed to read logs: ${String(error)}`);
      }
      process.exit(1);
    }
  });

// -----------------------------------------------------------------------------
// send command
// -----------------------------------------------------------------------------

program
  .command("send")
  .description("Send a test message")
  .requiredOption("--channel <channel>", "Channel: whatsapp or telegram")
  .requiredOption("--to <recipient>", "Recipient ID (phone number or chat ID)")
  .requiredOption("--message <text>", "Message text to send")
  .action(async (opts) => {
    const useJson = program.opts().json;
    const channel = opts.channel as string;
    const to = opts.to as string;
    const message = opts.message as string;

    if (channel !== "whatsapp" && channel !== "telegram") {
      if (useJson) {
        outputJson({ success: false, error: `Invalid channel: ${channel}. Must be 'whatsapp' or 'telegram'.` });
      } else {
        console.error(`Error: Invalid channel '${channel}'. Must be 'whatsapp' or 'telegram'.`);
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
      } else {
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
