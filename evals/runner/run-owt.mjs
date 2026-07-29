#!/usr/bin/env node
/** OpenWork testbed CLI bootstrap. */

if (!process.features?.typescript) {
  console.error("Node 24+ with native TypeScript required — run `nvm use`");
  process.exit(1);
}

const { main } = await import("./owt-cli.ts");

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
