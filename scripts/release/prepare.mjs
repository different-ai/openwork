#!/usr/bin/env node
/**
 * release:prepare [patch|minor|major]
 *
 * Bumps versions, runs lockfile check, runs release:review,
 * commits, and tags — but does NOT push.
 *
 * Flags:
 *   --dry-run   Print what would happen without mutating anything.
 *   --ci        Skip interactive-safety checks (branch, clean-tree).
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);

const dryRun = args.includes("--dry-run");
const ci = args.includes("--ci");
const bumpType = args.find((a) => ["patch", "minor", "major"].includes(a)) ?? "patch";

const log = (msg) => console.log(`  ${msg}`);
const heading = (msg) => console.log(`\n▸ ${msg}`);
const success = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
};

const run = (cmd, opts = {}) => {
  if (dryRun && !opts.readOnly) {
    log(`[dry-run] ${cmd}`);
    return "";
  }
  try {
    return execSync(cmd, { cwd: root, encoding: "utf8", stdio: opts.stdio ?? "pipe" }).trim();
  } catch (err) {
    if (opts.allowFail) return "";
    fail(`Command failed: ${cmd}\n${err.stderr || err.message}`);
  }
};

// ── Step 1: Verify state ────────────────────────────────────────────
heading("Checking git state");

if (!ci) {
  const branch = run("git rev-parse --abbrev-ref HEAD", { readOnly: true });
  if (branch !== "dev") fail(`Must be on 'dev' branch (currently on '${branch}')`);
  success(`On branch ${branch}`);
}

const dirty = run("git status --porcelain", { readOnly: true });
if (dirty && !ci) fail(`Working tree is dirty:\n${dirty}`);
success("Working tree clean");

heading("Syncing with origin/dev");
run("git fetch origin dev", { readOnly: true });
const behind = run("git rev-list HEAD..origin/dev --count", { readOnly: true });
if (behind !== "0" && !dryRun) {
  log(`Behind origin/dev by ${behind} commits — pulling…`);
  run("git pull --rebase origin dev");
}
success("Up to date with origin/dev");

// ── Step 2: Bump versions ───────────────────────────────────────────
heading(`Bumping versions (${bumpType})`);
const bumpOutput = run(`pnpm bump:${bumpType}`, { stdio: "pipe" });
if (!dryRun) {
  log(bumpOutput);
}

// Read the new version
const appPkg = JSON.parse(readFileSync(resolve(root, "apps/app/package.json"), "utf8"));
const version = appPkg.version;
success(`Version is now ${version}`);

// ── Step 3: Lockfile ────────────────────────────────────────────────
heading("Checking lockfile");
run("pnpm install --lockfile-only");
const lockfileChanged = run("git diff --name-only -- pnpm-lock.yaml", { readOnly: true });
if (lockfileChanged) {
  success("Lockfile updated");
} else {
  success("Lockfile unchanged");
}

// ── Step 4: Release review ──────────────────────────────────────────
heading("Running release review");
const reviewOutput = run("node scripts/release/review.mjs --strict", { readOnly: true, allowFail: false });
log(reviewOutput);
success("Release review passed");

// ── Step 5: Commit ──────────────────────────────────────────────────
heading("Committing version bump");
run("git add -A");
run(`git commit -m "chore: bump version to ${version}"`);
success(`Committed: chore: bump version to ${version}`);

// ── Step 6: Tag ─────────────────────────────────────────────────────
heading("Creating tag");
const tag = `v${version}`;
run(`git tag ${tag}`);
success(`Tagged ${tag}`);

// ── Summary ─────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(50));
console.log(`  Release prepared: ${tag}`);
console.log(`  Version:          ${version}`);
console.log(`  Bump type:        ${bumpType}`);
if (dryRun) {
  console.log("  Mode:             DRY RUN (nothing was changed)");
}
console.log("");
console.log("  Next step:");
console.log(`    pnpm release:ship`);
console.log("─".repeat(50) + "\n");
