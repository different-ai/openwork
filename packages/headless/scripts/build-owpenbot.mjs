import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(root, "..", "..");

function resolveOwpenbotRepo() {
  const envPath = process.env.OWPENBOT_DIR?.trim();
  const candidates = [envPath, resolve(repoRoot, "packages", "owpenbot")].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate && existsSync(resolve(candidate, "package.json"))) {
      return candidate;
    }
  }

  throw new Error("Owpenbot package not found. Expected packages/owpenbot in the monorepo.");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const owpenbotRepo = resolveOwpenbotRepo();
run("pnpm", ["install"], repoRoot);
const pkg = JSON.parse(readFileSync(resolve(owpenbotRepo, "package.json"), "utf8"));
const scripts = pkg?.scripts ?? {};
if (scripts["build:bin"]) {
  run("pnpm", ["--filter", "owpenwork", "build:bin"], repoRoot);
} else if (scripts["build:binary"]) {
  run("pnpm", ["--filter", "owpenwork", "build:binary"], repoRoot);
} else {
  run("bun", ["build", "--compile", "src/cli.ts", "--outfile", "dist/bin/owpenbot"], owpenbotRepo);
}
