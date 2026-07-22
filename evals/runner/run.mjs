#!/usr/bin/env node
/** OpenWork eval runner bootstrap. */

if (!process.features?.typescript) {
  console.error("Node 24+ with native TypeScript required — run `nvm use`");
  process.exit(1);
}

const { main } = await import("./cli.ts");

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
