import { Command } from "commander";

import { startBridge } from "./bridge.js";
import { loadConfig } from "./config.js";
import { BridgeStore } from "./db.js";
import { createLogger } from "./logger.js";
import { resolvePairingCode } from "./pairing.js";
import { loginWhatsApp } from "./whatsapp.js";

const program = new Command();

program.name("owpenbot").description("OpenCode WhatsApp + Telegram bridge");

const runStart = async () => {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const bridge = await startBridge(config, logger);

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
  .action(runStart);

program.action(runStart);

program
  .command("pairing-code")
  .description("Print the current pairing code")
  .action(() => {
    const config = loadConfig(process.env, { requireOpencode: false });
    const store = new BridgeStore(config.dbPath);
    const code = resolvePairingCode(store, config.pairingCode);
    console.log(code);
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

await program.parseAsync(process.argv);
