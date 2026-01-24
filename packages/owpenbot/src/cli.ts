#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { Command } from "commander";

import { startBridge, type BridgeReporter } from "./bridge.js";
import {
  loadConfig,
  normalizeWhatsAppId,
  readConfigFile,
  writeConfigFile,
  type ChannelName,
  type DmPolicy,
  type OwpenbotConfigFile,
} from "./config.js";
import { BridgeStore } from "./db.js";
import { createLogger } from "./logger.js";
import { createClient } from "./opencode.js";
import { truncateText } from "./text.js";
import { loginWhatsApp, unpairWhatsApp } from "./whatsapp.js";

const VERSION = "0.1.15";

type SetupStep = "config" | "whatsapp" | "telegram" | "start";

const STEP_OPTIONS: Array<{ value: SetupStep; label: string; hint?: string }> = [
  {
    value: "config",
    label: "Setup configuration",
    hint: "DM policy + allowlist",
  },
  {
    value: "whatsapp",
    label: "Link WhatsApp",
    hint: "Scan QR",
  },
  {
    value: "telegram",
    label: "Link Telegram",
    hint: "Optional",
  },
  {
    value: "start",
    label: "Start bridge",
    hint: "Listen for messages",
  },
];

const STEP_SET = new Set<SetupStep>(["config", "whatsapp", "telegram", "start"]);

function isInteractive() {
  return Boolean(process.stdin.isTTY || process.env.OWPENWORK_FORCE_TUI === "1");
}

function unwrap<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Setup cancelled");
    process.exit(0);
  }
  return value as T;
}

function parseSelections(raw?: string): SetupStep[] | null {
  if (!raw) return null;
  const selections = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item): item is SetupStep => STEP_SET.has(item as SetupStep));
  return selections.length ? selections : [];
}

function defaultSelections(configExists: boolean, whatsappLinked: boolean): SetupStep[] {
  const selections: SetupStep[] = [];
  if (!configExists) selections.push("config");
  if (!whatsappLinked) selections.push("whatsapp");
  selections.push("start");
  return selections;
}

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

function updateConfig(configPath: string, updater: (cfg: OwpenbotConfigFile) => OwpenbotConfigFile) {
  const { config } = readConfigFile(configPath);
  const base = config ?? { version: 1 };
  const next = updater(base);
  next.version = next.version ?? 1;
  writeConfigFile(configPath, next);
  return next;
}

async function runSetupWizard(
  config: ReturnType<typeof loadConfig>,
  options: { nonInteractive: boolean; useTui: boolean },
) {
  const testMode = process.env.OWPENWORK_TEST_SETUP;
  const next = updateConfig(config.configPath, (cfg) => ({ ...cfg }));

  if (options.nonInteractive || testMode) {
    next.channels = next.channels ?? {};
    const mode = testMode === "dedicated" ? "dedicated" : "personal";
    const allowFrom = mode === "personal" ? ["+15551234567"] : [];
    next.channels.whatsapp = {
      dmPolicy: mode === "personal" ? "allowlist" : "pairing",
      allowFrom,
      selfChatMode: mode === "personal",
      accounts: {
        [config.whatsappAccountId]: {
          authDir: config.whatsappAuthDir,
        },
      },
    };
    writeConfigFile(config.configPath, next);
    log.success(`Wrote ${config.configPath}`);
    return;
  }

  if (options.useTui) {
    const mode = unwrap(
      await select({
        message: "WhatsApp number",
        options: [
          {
            value: "personal",
            label: "Personal number (no pairing)",
            hint: "Allowlist your own number",
          },
          {
            value: "dedicated",
            label: "Dedicated number",
            hint: "Pairing or allowlist",
          },
        ],
        initialValue: "personal",
      }),
    ) as "personal" | "dedicated";

    let dmPolicy: DmPolicy = "pairing";
    let allowFrom: string[] = [];
    let selfChatMode = false;

    if (mode === "personal") {
      const number = unwrap(
        await text({
          message: "Your WhatsApp number (E.164)",
          placeholder: "+15551234567",
          validate: (value: string) => {
            const normalized = normalizeWhatsAppId(String(value ?? ""));
            return /^\+\d+$/.test(normalized) ? undefined : "Use E.164 format (+123...)";
          },
        }),
      ) as string;
      allowFrom = [normalizeWhatsAppId(number)];
      dmPolicy = "allowlist";
      selfChatMode = true;
    } else {
      dmPolicy = unwrap(
        await select({
          message: "Direct messages",
          options: [
            { value: "pairing", label: "Pairing (recommended)" },
            { value: "allowlist", label: "Allowlist only" },
            { value: "open", label: "Open (public)" },
            { value: "disabled", label: "Disabled" },
          ],
          initialValue: "pairing",
        }),
      ) as DmPolicy;

      const listInput = unwrap(
        await text({
          message: "Allowlist numbers (comma-separated, optional)",
          placeholder: "+15551234567, +15551234568",
        }),
      ) as string;
      if (listInput.trim()) {
        allowFrom = listInput
          .split(",")
          .map((item) => normalizeWhatsAppId(item))
          .filter(Boolean);
      }
      if (dmPolicy === "open") {
        allowFrom = allowFrom.length ? allowFrom : ["*"];
      }
    }

    const currentWorkspace = config.configFile.opencodeDirectory ?? config.opencodeDirectory;
    const keepDefault = unwrap(
      await confirm({
        message: `Use this OpenCode workspace? (${currentWorkspace})`,
        initialValue: true,
      }),
    ) as boolean;

    if (!keepDefault) {
      const workspace = unwrap(
        await text({
          message: "OpenCode workspace path",
          placeholder: "/path/to/workspace",
          validate: (value: string) => (String(value ?? "").trim() ? undefined : "Path required"),
        }),
      ) as string;
      next.opencodeDirectory = workspace.trim();
    }

    next.channels = next.channels ?? {};
    next.channels.whatsapp = {
      dmPolicy,
      allowFrom,
      selfChatMode,
      accounts: {
        [config.whatsappAccountId]: {
          authDir: config.whatsappAuthDir,
        },
      },
    };
    writeConfigFile(config.configPath, next);
    log.success(`Wrote ${config.configPath}`);
    return;
  }
}

async function runTelegramSetup(config: ReturnType<typeof loadConfig>, tokenOverride?: string) {
  const tokenFromEnv = tokenOverride ?? process.env.OWPENWORK_TEST_TELEGRAM_TOKEN;
  let token = tokenFromEnv || config.telegramToken;
  if (!token) {
    if (!isInteractive()) {
      log.warn("Telegram token missing. Provide TELEGRAM_BOT_TOKEN or use login command.");
      return;
    }
    token = unwrap(
      await text({
        message: "Telegram bot token",
        placeholder: "123456:ABCDEF...",
        validate: (value: string) => (String(value ?? "").trim() ? undefined : "Token required"),
      }),
    ) as string;
  }

  updateConfig(config.configPath, (cfg) => {
    const next = { ...cfg } as OwpenbotConfigFile;
    next.channels = next.channels ?? {};
    next.channels.telegram = {
      token,
      enabled: true,
    };
    return next;
  });
  log.success("Telegram token saved.");
}

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

async function runGuidedFlow(pathArg: string | undefined, opts: { nonInteractive: boolean; check: boolean }) {
  if (pathArg?.trim()) {
    process.env.OPENCODE_DIRECTORY = pathArg.trim();
  }
  let config = loadConfig(process.env, { requireOpencode: false });
  if (!process.env.OPENCODE_DIRECTORY) {
    process.env.OPENCODE_DIRECTORY = config.opencodeDirectory;
  }

  const authPath = path.join(config.whatsappAuthDir, "creds.json");
  const whatsappLinked = fs.existsSync(authPath);
  const configExists = fs.existsSync(config.configPath);

  if (opts.check) {
    console.log(`Config: ${configExists ? "yes" : "no"}`);
    console.log(`WhatsApp linked: ${whatsappLinked ? "yes" : "no"}`);
    console.log(`Telegram configured: ${config.telegramToken ? "yes" : "no"}`);
    process.exit(configExists && whatsappLinked ? 0 : 1);
  }

  if (opts.nonInteractive) {
    await runSetupWizard(config, { nonInteractive: true, useTui: false });
    console.log("Next: owpenwork whatsapp login");
    return;
  }

  if (!isInteractive()) {
    console.log("Non-interactive shell. Run `owpenwork start` or `owpenwork --non-interactive`.");
    return;
  }

  intro("Owpenwork Setup");
  const selectedFromEnv = parseSelections(process.env.OWPENWORK_TEST_SELECTIONS);
  const selections = selectedFromEnv ??
    unwrap(
      await multiselect({
        message: "Select what to set up",
        options: STEP_OPTIONS,
        initialValues: defaultSelections(configExists, whatsappLinked),
        required: false,
      }),
    );

  const selectedSteps = Array.isArray(selections) ? selections : [];
  if (!selectedSteps.length) {
    cancel("No steps selected");
    process.exit(0);
  }

  const total = selectedSteps.length;
  let index = 1;

  const runStep = async (label: string, task: () => Promise<void>) => {
    const spin = spinner();
    spin.start(`Step ${index}/${total}: ${label}`);
    await task();
    spin.stop(`Step ${index}/${total}: ${label} done`);
    index += 1;
  };

  for (const step of selectedSteps) {
    if (step === "config") {
      await runStep("Setup configuration", async () => {
        await runSetupWizard(config, { nonInteractive: false, useTui: true });
        config = loadConfig(process.env, { requireOpencode: false });
      });
      continue;
    }

    if (step === "whatsapp") {
        await runStep("Link WhatsApp", async () => {
          const alreadyLinked = fs.existsSync(authPath);
          if (alreadyLinked) {
            const relink = unwrap(
              await confirm({
                message: "WhatsApp already linked. Relink?",
                initialValue: false,
              }),
            ) as boolean;
            if (!relink) return;
          }
          await loginWhatsApp(config, createAppLogger(config), { onStatus: console.log });
        });
        continue;
      }

    if (step === "telegram") {
      await runStep("Link Telegram", async () => {
        await runTelegramSetup(config);
        config = loadConfig(process.env, { requireOpencode: false });
      });
      continue;
    }

    if (step === "start") {
      log.info("Starting bridge...");
      outro("Owpenwork is running.");
      await runStart(pathArg);
    }
  }

  if (!selectedSteps.includes("start")) {
    outro("Setup complete.");
  }
}

const program = new Command();

program
  .name("owpenbot")
  .version(VERSION)
  .description("OpenCode WhatsApp + Telegram bridge")
  .argument("[path]")
  .option("--non-interactive", "Run setup defaults and exit", false)
  .option("--check", "Validate config/auth and exit", false);

program
  .command("start")
  .description("Start the bridge")
  .action(() => runStart());

program.action((pathArg: string | undefined) => {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    program.outputHelp();
    return;
  }
  const opts = program.opts<{ nonInteractive: boolean; check: boolean }>();
  return runGuidedFlow(pathArg, { nonInteractive: Boolean(opts.nonInteractive), check: Boolean(opts.check) });
});

program
  .command("setup")
  .description("Create or update owpenbot.json for WhatsApp")
  .option("--non-interactive", "Write defaults without prompts", false)
  .action(async (opts) => {
    const config = loadConfig(process.env, { requireOpencode: false });
    if (!isInteractive() && !opts.nonInteractive) {
      console.log("Non-interactive shell. Use --non-interactive.");
      return;
    }
    intro("Owpenwork Setup");
    await runSetupWizard(config, { nonInteractive: Boolean(opts.nonInteractive), useTui: true });
    outro("Setup complete.");
  });

const login = program.command("login").description("Link channels");

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
  .action(async (opts) => {
    const config = loadConfig(process.env, { requireOpencode: false });
    await runTelegramSetup(config, opts.token as string | undefined);
  });

program
  .command("pairing-code")
  .description("List pending pairing codes")
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

const whatsapp = program.command("whatsapp").description("WhatsApp helpers");

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
    const config = loadConfig(process.env, { requireOpencode: false });
    unpairWhatsApp(config, createAppLogger(config));
  });

program
  .command("qr")
  .description("Print a WhatsApp QR code to pair")
  .action(async () => {
    const config = loadConfig(process.env, { requireOpencode: false });
    await loginWhatsApp(config, createAppLogger(config), { onStatus: console.log });
  });

program
  .command("unpair")
  .description("Clear WhatsApp pairing data")
  .action(() => {
    const config = loadConfig(process.env, { requireOpencode: false });
    unpairWhatsApp(config, createAppLogger(config));
  });

const pairing = program.command("pairing").description("Pairing requests");

pairing
  .command("list")
  .description("List pending pairing requests")
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

pairing
  .command("approve")
  .argument("<code>")
  .description("Approve a pairing request")
  .action((code: string) => {
    const config = loadConfig(process.env, { requireOpencode: false });
    const store = new BridgeStore(config.dbPath);
    const request = store.approvePairingRequest("whatsapp", code.trim());
    if (!request) {
      console.log("Pairing code not found or expired.");
      store.close();
      return;
    }
    store.allowPeer("whatsapp", request.peer_id);
    store.close();
    console.log(`Approved ${request.peer_id}`);
  });

pairing
  .command("deny")
  .argument("<code>")
  .description("Deny a pairing request")
  .action((code: string) => {
    const config = loadConfig(process.env, { requireOpencode: false });
    const store = new BridgeStore(config.dbPath);
    const ok = store.denyPairingRequest("whatsapp", code.trim());
    store.close();
    console.log(ok ? "Removed pairing request." : "Pairing code not found.");
  });

program
  .command("status")
  .description("Show WhatsApp and OpenCode status")
  .action(async () => {
    const config = loadConfig(process.env, { requireOpencode: false });
    const authPath = `${config.whatsappAuthDir}/creds.json`;
    const linked = fs.existsSync(authPath);
    console.log(`Config: ${config.configPath}`);
    console.log(`WhatsApp linked: ${linked ? "yes" : "no"}`);
    console.log(`Telegram configured: ${config.telegramToken ? "yes" : "no"}`);
    console.log(`Auth dir: ${config.whatsappAuthDir}`);
    console.log(`OpenCode URL: ${config.opencodeUrl}`);
  });

program
  .command("doctor")
  .description("Diagnose common issues")
  .option("--reset", "Reset owpenbot state", false)
  .action(async (opts) => {
    const config = loadConfig(process.env, { requireOpencode: false });
    const authPath = `${config.whatsappAuthDir}/creds.json`;
    if (!fs.existsSync(authPath)) {
      console.log("WhatsApp not linked. Run: owpenwork whatsapp login");
    } else {
      console.log("WhatsApp linked.");
    }
    console.log(`OpenCode URL: ${config.opencodeUrl}`);
    try {
      const client = createClient(config);
      const health = await client.global.health();
      const healthy = Boolean((health as { healthy?: boolean }).healthy);
      console.log(`OpenCode reachable: ${healthy ? "yes" : "no"}`);
    } catch (error) {
      console.log("OpenCode reachable: no");
      console.log(`Error: ${String(error)}`);
    }
    console.log("If replies fail, ensure the server is running.");

    const resetRequested = Boolean(opts.reset);
    if (!resetRequested && !process.stdin.isTTY) return;

    let confirmed = resetRequested;
    if (!resetRequested) {
      const answer = await confirm({ message: "Reset owpenbot state?", initialValue: false });
      if (isCancel(answer)) {
        cancel("Reset cancelled");
        return;
      }
      confirmed = Boolean(answer);
    }

    if (!confirmed) return;

    const targets = [config.configPath, config.dbPath, config.whatsappAuthDir];
    for (const target of targets) {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
    console.log("Reset complete. Run: owpenwork");
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
