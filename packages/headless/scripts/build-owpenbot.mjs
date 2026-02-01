import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(root, "..", "..");

function resolveOwpenbotRepo() {
  const envPath = process.env.OWPENBOT_REPO?.trim() || process.env.OWPENBOT_DIR?.trim();
  const candidates = [envPath, resolve(repoRoot, "..", "owpenbot"), resolve(repoRoot, "vendor", "owpenbot")].filter(
    Boolean,
  );

  for (const candidate of candidates) {
    if (candidate && existsSync(resolve(candidate, "package.json"))) {
      return candidate;
    }
  }

  const cloneTarget = envPath ?? resolve(repoRoot, "..", "owpenbot");
  const repoUrl = process.env.OWPENBOT_REPO_URL?.trim() || "https://github.com/different-ai/owpenbot.git";
  const repoRef = process.env.OWPENBOT_REF?.trim() || "dev";

  if (!cloneTarget) {
    throw new Error("OWPENBOT_REPO not found and no clone target available.");
  }

  const result = spawnSync("git", ["clone", "--depth", "1", "--branch", repoRef, repoUrl, cloneTarget], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Failed to clone owpenbot from ${repoUrl}`);
  }

  if (!existsSync(resolve(cloneTarget, "package.json"))) {
    throw new Error(`Owpenbot package.json not found in ${cloneTarget}`);
  }

  return cloneTarget;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const owpenbotRepo = resolveOwpenbotRepo();
run("bun", ["install"], owpenbotRepo);
const pkg = JSON.parse(readFileSync(resolve(owpenbotRepo, "package.json"), "utf8"));
const scripts = pkg?.scripts ?? {};
if (scripts["build:bin"]) {
  run("bun", ["run", "build:bin"], owpenbotRepo);
} else if (scripts["build:binary"]) {
  run("bun", ["run", "build:binary"], owpenbotRepo);
} else {
  run("bun", ["build", "--compile", "src/cli.ts", "--outfile", "dist/bin/owpenbot"], owpenbotRepo);
}
