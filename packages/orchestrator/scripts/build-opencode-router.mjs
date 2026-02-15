import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(root, "..", "..");

function resolveOpencodeRouterRepo() {
  const envPath = process.env.OPENCODE_ROUTER_DIR?.trim();
  const candidates = [envPath, resolve(repoRoot, "packages", "opencode-router")].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate && existsSync(resolve(candidate, "package.json"))) {
      return candidate;
    }
  }

  throw new Error("OpenCodeRouter package not found. Expected packages/opencode-router in the monorepo.");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const routerRepo = resolveOpencodeRouterRepo();
run("pnpm", ["install"], repoRoot);
const pkg = JSON.parse(readFileSync(resolve(routerRepo, "package.json"), "utf8"));
const scripts = pkg?.scripts ?? {};
if (scripts["build:bin"]) {
  run("pnpm", ["--filter", "opencode-router", "build:bin"], repoRoot);
} else if (scripts["build:binary"]) {
  run("pnpm", ["--filter", "opencode-router", "build:binary"], repoRoot);
} else {
  run("bun", ["build", "--compile", "src/cli.ts", "--outfile", "dist/bin/opencode-router"], routerRepo);
}
