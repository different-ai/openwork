#!/usr/bin/env node
/** World CLI bootstrap. */

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
if (nodeMajor < 24 || !process.features?.typescript) {
  console.error("Node 24+ with native TypeScript required — run `nvm use`");
  process.exit(1);
}

const { main } = await import("../packages/env/src/cli.ts");

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
