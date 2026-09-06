import { readdir, readFile } from "node:fs/promises";

const specs = new URL("../specs/", import.meta.url);
const files = (await readdir(specs))
  .filter((file) => file.endsWith(".e2e.test.ts"))
  .sort();

for (const file of files) {
  // This journey uses app(), but chmods its local Electron profile and
  // restarts it against two independent local Den servers. Keep its full
  // rollback/recovery proof runnable with evals:e2e <slug> --local; selecting
  // it for Daytona only produces an Incomplete skip, never product evidence.
  if (file === "cross-server-handoff-atomic-commit.e2e.test.ts") {
    console.log(file);
    continue;
  }
  const source = await readFile(new URL(file, specs), "utf8");
  if (/import\s*\{[^}]*\bdesktop\b[^}]*\}\s*from\s*["']@openwork\/hosts["']/s.test(source)) {
    console.log(file);
  }
}
