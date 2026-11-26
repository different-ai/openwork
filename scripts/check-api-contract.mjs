#!/usr/bin/env node
// `pnpm check api-contract`: build the Den API contract from the current
// sources (reused when nothing changed) and lint it against the baseline, the
// same lint the API Contract workflow runs after a merge to dev.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
try {
  execFileSync(process.execPath, ["scripts/den-contract.mjs", "--if-needed"], { cwd: root, stdio: "inherit" });
  execFileSync(process.execPath, ["scripts/api-lint.mjs"], { cwd: root, stdio: "inherit" });
} catch (error) {
  process.exit(typeof error.status === "number" ? error.status : 1);
}
