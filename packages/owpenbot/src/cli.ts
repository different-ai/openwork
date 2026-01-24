import fs from "node:fs";
import { createInterface } from "node:readline/promises";

import { Command } from "commander";

import { startBridge } from "./bridge.js";
import {
  loadConfig,
  normalizeWhatsAppId,
  readConfigFile,
  writeConfigFile,
  type DmPolicy,
  type OwpenbotConfigFile,
} from "./config.js";
import { BridgeStore } from "./db.js";
import { createLogger } from "./logger.js";
import { loginWhatsApp, unpairWhatsApp } from "./whatsapp.js";

const program = new Command();


program
  .name("owpenbot")
  .description("OpenCode WhatsApp + Telegram bridge")
  .argument("[path]");

const runStart = async (pathOverride?: string) => {
  if (pathOverride?.trim()) {
    process.env.OPENCODE_DIRECTORY = pathOverride.trim();
  }
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  if (!process.env.OPENCODE_DIRECTORY) {
    process.env.OPENCODE_DIRECTORY = config.opencodeDirectory;
  }
  const bridge = await startBridge(config, logger);
  logger.info("Commands: owpenbot whatsapp login, owpenbot pairing list, owpenbot status");

  const shutdown = async () => {
    logger.info("shutting down");
    await bridge.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

program
  .command("start")
  .description("Start the bridge")
  .action(() => runStart());

program.action((pathArg: string | undefined) => runStart(pathArg));

program
  .command("setup")
  .description("Create or update owpenbot.json for WhatsApp")
  .option("--non-interactive", "Write defaults without prompts", false)
  .action(async (opts) => {
    const config = loadConfig(process.env, { requireOpencode: false });
    const { config: existing } = readConfigFile(config.configPath);
    const next: OwpenbotConfigFile = existing ?? { version: 1 };

    if (opts.nonInteractive) {
      next.version = 1;
      next.channels = next.channels ?? {};
      next.channels.whatsapp = {
        dmPolicy: "pairing",
        allowFrom: [],
        selfChatMode: false,
        accounts: {
          [config.whatsappAccountId]: {
            authDir: config.whatsappAuthDir,
          },
        },
      };
      writeConfigFile(config.configPath, next);
      console.log(`Wrote ${config.configPath}`);
      return;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const phoneMode = await rl.question(
      "WhatsApp setup: (1) Personal number (2) Dedicated number [1]: ",
    );
    const mode = phoneMode.trim() === "2" ? "dedicated" : "personal";

    let dmPolicy: DmPolicy = "pairing";
    let allowFrom: string[] = [];
    let selfChatMode = false;

    if (mode === "personal") {
      let normalized = "";
      while (!normalized) {
        const number = await rl.question("Your WhatsApp number (E.164, e.g. +15551234567): ");
        const candidate = normalizeWhatsAppId(number);
        if (!/^\+\d+$/.test(candidate)) {
          console.log("Invalid number. Try again.");
          continue;
        }
        normalized = candidate;
      }
      allowFrom = [normalized];
      dmPolicy = "allowlist";
      selfChatMode = true;
    } else {
      const policyInput = await rl.question(
        "DM policy: (1) Pairing (2) Allowlist (3) Open (4) Disabled [1]: ",
      );
      const policyChoice = policyInput.trim();
      if (policyChoice === "2") dmPolicy = "allowlist";
      else if (policyChoice === "3") dmPolicy = "open";
      else if (policyChoice === "4") dmPolicy = "disabled";
      else dmPolicy = "pairing";

      const listInput = await rl.question(
        "Allowlist numbers (comma-separated, optional): ",
      );
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

    rl.close();

    next.version = 1;
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
    console.log(`Wrote ${config.configPath}`);
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
    const logger = createLogger(config.logLevel);
    await loginWhatsApp(config, logger);
  });

whatsapp
  .command("logout")
  .description("Logout of WhatsApp and clear auth state")
  .action(() => {
    const config = loadConfig(process.env, { requireOpencode: false });
    const logger = createLogger(config.logLevel);
    unpairWhatsApp(config, logger);
  });

program
  .command("qr")
  .description("Print a WhatsApp QR code to pair")
  .action(async () => {
    const config = loadConfig(process.env, { requireOpencode: false });
    const logger = createLogger(config.logLevel);
    await loginWhatsApp(config, logger);
  });

program
  .command("unpair")
  .description("Clear WhatsApp pairing data")
  .action(() => {
    const config = loadConfig(process.env, { requireOpencode: false });
    const logger = createLogger(config.logLevel);
    unpairWhatsApp(config, logger);
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
    console.log(`Auth dir: ${config.whatsappAuthDir}`);
    console.log(`OpenCode URL: ${config.opencodeUrl}`);
  });

program
  .command("doctor")
  .description("Diagnose common issues")
  .action(async () => {
    const config = loadConfig(process.env, { requireOpencode: false });
    const authPath = `${config.whatsappAuthDir}/creds.json`;
    if (!fs.existsSync(authPath)) {
      console.log("WhatsApp not linked. Run: owpenbot whatsapp login");
    } else {
      console.log("WhatsApp linked.");
    }
    console.log("If replies fail, ensure OpenCode server is running at OPENCODE_URL.");
  });

await program.parseAsync(process.argv);
