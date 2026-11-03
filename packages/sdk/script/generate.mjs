import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { createClient } from "@hey-api/openapi-ts";
import { format } from "prettier";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const repoDir = fileURLToPath(new URL("../../..", import.meta.url));
const { values } = parseArgs({ options: { input: { type: "string" } } });
if (!values.input) {
  execFileSync(process.execPath, [join(repoDir, "scripts/den-contract.mjs")], { cwd: repoDir, stdio: "inherit" });
  process.exit(0);
}

async function files(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await files(join(directory, entry.name), path));
    else result.push(path);
  }
  return result.sort();
}

const input = resolve(process.cwd(), values.input);
const output = join(packageDir, "src/gen");
await createClient({
  input,
  output: { path: output, tsConfigPath: join(packageDir, "tsconfig.json"), clean: true },
  plugins: [
    { name: "@hey-api/typescript", exportFromIndex: false },
    { name: "@hey-api/sdk", instance: "DenClient", exportFromIndex: false, auth: false, paramsStructure: "flat" },
    { name: "@hey-api/client-fetch", exportFromIndex: false, baseUrl: "https://api.openworklabs.com" },
  ],
});
const generatedFiles = await files(output);
for (const file of generatedFiles) {
  const path = join(output, file);
  await writeFile(path, await format(await readFile(path, "utf8"), { parser: "typescript", printWidth: 120 }));
}
