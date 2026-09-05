import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@hey-api/openapi-ts";
import { format } from "prettier";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const repoDir = fileURLToPath(new URL("../../..", import.meta.url));
const check = process.argv.includes("--check");
const temporary = await mkdtemp(join(tmpdir(), "openwork-sdk-"));

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

try {
  // This workspace package exposes built browser assets even in development.
  execFileSync("pnpm", ["--filter", "@openwork/mcp-apps", "build"], { cwd: repoDir, stdio: "inherit" });
  const input = join(temporary, "openapi.json");
  execFileSync("pnpm", ["--filter", "@openwork-ee/den-api", "exec", "tsx", "--conditions=development",
    "scripts/generate-openapi-snapshot.ts", "--output", input], { cwd: repoDir, stdio: "inherit" });
  const committed = join(packageDir, "src/gen");
  const output = check ? join(temporary, "gen") : committed;
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
  if (check) {
    const committedFiles = await files(committed);
    const changed = generatedFiles.join("\n") !== committedFiles.join("\n")
      || (await Promise.all(generatedFiles.map(async (file) =>
        !(await readFile(join(output, file))).equals(await readFile(join(committed, file)))
      ))).some(Boolean);
    if (changed) throw new Error("Generated SDK is stale. Run pnpm sdk:generate and commit packages/sdk/src/gen.");
    console.log("Generated SDK matches the Den route schemas.");
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
