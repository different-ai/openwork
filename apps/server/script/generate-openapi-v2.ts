import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { v2App } from "../src/v2/app.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(scriptDir, "../openapi/v2.json");

async function writeIfChanged(filePath: string, contents: string) {
  try {
    const current = await readFile(filePath, "utf8");
    if (current === contents) {
      return false;
    }
  } catch {
    // ignore missing file
  }

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
  return true;
}

async function main() {
  const response = await v2App.request("http://openwork.local/openapi.json");
  if (!response.ok) {
    throw new Error(`failed to generate OpenAPI document: ${response.status} ${response.statusText}`);
  }

  const document = await response.json();
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  const changed = await writeIfChanged(outputPath, contents);

  process.stdout.write(`[openwork-server:v2] ${changed ? "wrote" : "verified"} ${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
