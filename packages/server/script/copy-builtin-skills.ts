import { cp, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, "..", "src", "builtin-skills");
const destDir = join(__dirname, "..", "dist", "builtin-skills");

async function main() {
  await mkdir(destDir, { recursive: true });
  await cp(srcDir, destDir, { recursive: true });
  console.log("Copied builtin-skills to dist/");
}

main().catch((err) => {
  console.error("Failed to copy builtin-skills:", err);
  process.exit(1);
});
