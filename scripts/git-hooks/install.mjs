// Points git at the tracked hooks directory so every clone runs the
// confidentiality tripwire on push. Invoked from the root `prepare` script;
// a no-op in CI, outside a git checkout, or when the user opted out.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hooksDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(hooksDir, "../..");

if (process.env.CI || process.env.OPENWORK_SKIP_GIT_HOOKS === "1" || !existsSync(resolve(repoRoot, ".git"))) {
  process.exit(0);
}

function currentHooksPath() {
  try {
    return execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return ""; // exit 1 means the key is unset
  }
}

try {
  const current = currentHooksPath();
  const wanted = relative(repoRoot, hooksDir).split("\\").join("/");
  if (current === wanted) process.exit(0);
  if (current && current !== wanted) {
    console.warn(`[git-hooks] core.hooksPath is already "${current}"; not overriding. Run: git config core.hooksPath ${wanted}`);
    process.exit(0);
  }
  execFileSync("git", ["config", "core.hooksPath", wanted], { cwd: repoRoot, stdio: "ignore" });
  console.log(`[git-hooks] installed pre-push confidentiality tripwire (core.hooksPath=${wanted})`);
} catch {
  // git unavailable or config unwritable: never fail an install over a hook.
}
