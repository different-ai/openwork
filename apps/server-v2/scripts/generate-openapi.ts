import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppDependencies } from "../src/context/app-dependencies.js";
import { createApp } from "../src/app-factory.js";
import { resolveServerV2Version } from "../src/version.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const outputPath = resolve(packageDir, "openapi/openapi.json");

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
  const workingDirectory = await mkdtemp(join(os.tmpdir(), "openwork-server-v2-openapi-"));
  const dependencies = createAppDependencies({
    environment: "test",
    inMemory: true,
    version: resolveServerV2Version(),
    workingDirectory,
  });
  try {
    const app = createApp({ dependencies });
    const response = await app.request("http://openwork.local/openapi.json");

    if (!response.ok) {
      throw new Error(`Failed to generate OpenAPI document: ${response.status} ${response.statusText}`);
    }

    const document = await response.json();
    const contents = `${JSON.stringify(document, null, 2)}\n`;
    const changed = await writeIfChanged(outputPath, contents);

    process.stdout.write(`[openwork-server-v2] ${changed ? "wrote" : "verified"} ${outputPath}\n`);
  } finally {
    await dependencies.close();
    await rm(workingDirectory, { force: true, recursive: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
