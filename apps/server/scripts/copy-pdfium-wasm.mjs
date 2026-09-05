// Places the PDFium wasm binary next to the bundled openwork-pdf-attachments
// plugin. The plugin is loaded by the OpenCode engine from a directory without
// node_modules (dist/opencode-plugins in development, Resources/opencode-plugins
// in packaged apps), so the runtime must travel as a sibling file.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const outdir = process.argv[2];
if (!outdir) {
  console.error("usage: node scripts/copy-pdfium-wasm.mjs <outdir>");
  process.exit(1);
}

const require = createRequire(import.meta.url);
const source = require.resolve("@hyzyla/pdfium/pdfium.wasm");
const target = join(resolve(outdir), "pdfium.wasm");
mkdirSync(resolve(outdir), { recursive: true });
copyFileSync(source, target);
process.stdout.write(`${JSON.stringify({ copied: target })}\n`);
