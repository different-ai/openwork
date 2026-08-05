#!/usr/bin/env node
/**
 * release:ship
 *
 * Pushes the current tag + dev branch to origin, then prints the
 * GitHub Actions workflow URL. Optionally tails the workflow run.
 *
 * Flags:
 *   --dry-run   Print what would happen without pushing.
 *   --watch     Tail the GHA workflow run after push.
 */
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);

const dryRun = args.includes("--dry-run");
const watch = args.includes("--watch");

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
    return execSync(cmd, {
      cwd: root,
      encoding: "utf8",
      stdio: opts.inherit ? "inherit" : "pipe",
    }).trim();
  } catch (err) {
    if (opts.allowFail) return "";
    fail(`Command failed: ${cmd}\n${err.stderr || err.message}`);
  }
};

// ── Step 1: Resolve tag from HEAD ───────────────────────────────────
heading("Resolving tag");

const tag = run("git describe --tags --exact-match HEAD", {
  readOnly: true,
  allowFail: true,
});

if (!tag) {
  fail(
    "HEAD is not tagged. Run 'pnpm release:prepare' first.\n" +
    "  (Expected a vX.Y.Z tag on HEAD)"
  );
}

if (!/^v\d+\.\d+\.\d+/.test(tag)) {
  fail(`Tag '${tag}' does not look like a release tag (expected vX.Y.Z)`);
}

success(`Found tag: ${tag}`);

// ── Step 2: Push tag ────────────────────────────────────────────────
heading("Pushing tag to origin");
run(`git push origin ${tag}`);
success(`Pushed ${tag}`);

// ── Step 3: Push dev ────────────────────────────────────────────────
heading("Pushing dev to origin");
run("git push origin dev");
success("Pushed dev");

// ── Step 4: Print workflow URL ──────────────────────────────────────
heading("GitHub Actions");

const repo = "different-ai/micx";
const url = `https://github.com/${repo}/actions/workflows/release-macos-aarch64.yml`;
log(`Workflow: ${url}`);
log(`Release:  https://github.com/${repo}/releases/tag/${tag}`);

// ── Step 5: Optionally watch ────────────────────────────────────────
if (watch && !dryRun) {
  heading("Watching workflow run");
  log("Waiting for workflow to appear…");

  // Give GitHub a moment to register the run
  execSync("sleep 10", { cwd: root });

  try {
    const runs = run(
      `gh run list --repo ${repo} --workflow "Release App" --limit 1 --json databaseId,headBranch,event -q ".[0].databaseId"`,
      { readOnly: true }
    );
    if (runs) {
      log(`Run ID: ${runs}`);
      run(`gh run watch ${runs} --repo ${repo} --exit-status`, { inherit: true });
    } else {
      log("Could not find the workflow run. Check the Actions tab manually.");
    }
  } catch {
    log("Workflow watch exited (check status on GitHub).");
  }
}

// ── Summary ─────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(50));
console.log(`  Shipped: ${tag}`);
if (dryRun) {
  console.log("  Mode:    DRY RUN (nothing was pushed)");
}
console.log("─".repeat(50) + "\n");
