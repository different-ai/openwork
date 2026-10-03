// Freestyle world check: proves the e2e/preview world end to end, with timings.
//
//   node evals/scripts/check-freestyle-world.ts [--only docs,ui,den-api,den-web,server] [--base <sha>] [--keep-branches]
//
// WORLD_CHECK_VERBOSE=1 prints each build stage with its time.
// --base tests a pushed branch as if it were dev (default: the dev head), e.g. to
// prove a change to the world itself before it merges.
//
// 1. Warms dev's world exactly like the dev push workflow.
// 2. Pushes throwaway commits on top of dev (tmp/world-check/*), one per scenario.
// 3. For each: builds its world (timed, fast or full path), runs the core journey
//    against it, and checks the change is really live where it applies.
// 4. Prints one table and deletes the throwaway branches.
//
// Needs FREESTYLE_API_KEY, push access to the repo, and an installed evals workspace.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserScript } from "@openwork/cdp";
import { evalIn } from "@openwork/behaviors";
import { freestyleEvidenceWeb } from "@openwork/env";
import { devHead, ensureEvidenceSnapshot } from "../../packages/freestyle/src/evidence-builder.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const git = (args: string[], cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

interface Scenario {
  name: string;
  expect: "reused" | "fast" | "full";
  change: (dir: string) => Promise<void>;
  /** Text that must be on screen in the world when the change is live. */
  marker?: string;
}

// Unique per run, so every scenario really builds instead of reusing an earlier run's world.
const stamp = Date.now().toString(36);
const UI_MARKER = `What do you need done? (world check ${stamp})`;
const scenarios: Scenario[] = [
  { name: "docs", expect: "reused", change: async (dir) => appendFile(join(dir, "README.md"), `\n<!-- world check ${stamp} -->\n`) },
  { name: "ui", expect: "fast", marker: UI_MARKER, change: async (dir) => {
    const file = join(dir, "apps/app/src/react-app/domains/session/chat/session-empty-hero.tsx");
    const text = await readFile(file, "utf8");
    if (!text.includes("What do you need done?")) throw new Error("UI scenario anchor text moved; update check-freestyle-world.ts");
    await writeFile(file, text.replace("What do you need done?", UI_MARKER));
  } },
  { name: "den-api", expect: "fast", change: async (dir) => appendFile(join(dir, "ee/apps/den-api/src/main.ts"), `\n// world check ${stamp}\n`) },
  { name: "den-web", expect: "fast", change: async (dir) => appendFile(join(dir, "ee/apps/den-web/app/layout.tsx"), `\n// world check ${stamp}\n`) },
  { name: "server", expect: "full", change: async (dir) => appendFile(join(dir, "apps/server/src/cli.ts"), `\n// world check ${stamp}\n`) },
];

const args = process.argv.slice(2);
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : null;
const keep = args.includes("--keep-branches");
if (!process.env.FREESTYLE_API_KEY?.trim()) throw new Error("FREESTYLE_API_KEY is required");
process.env.OPENWORK_PREVIEW_GITHUB_TOKEN ||= spawnSync("gh", ["auth", "token"], { encoding: "utf8" }).stdout.trim();

const seconds = (start: number) => Math.round((performance.now() - start) / 1000);
async function prepare(sha: string, imageSha?: string) {
  const start = performance.now();
  if (process.env.WORLD_CHECK_VERBOSE) console.log(`    · start`);
  let path = "reused";
  let reason = "";
  await ensureEvidenceSnapshot(sha, undefined, {
    imageSha,
    observe: (event) => { if (process.env.WORLD_CHECK_VERBOSE) console.log(`    · ${event.stage} ${Math.round(event.durationMs / 1000)}s${event.cacheHit === undefined ? "" : event.cacheHit ? " (reused)" : " (built)"}`); if (event.stage.startsWith("path:")) { path = event.stage.includes("fast") ? "fast" : "full"; reason = event.reason ?? ""; } },
    diagnostic: async (stage, log) => console.error(`--- ${stage} builder log (last 60 lines) ---\n${log.split("\n").slice(-60).join("\n")}`),
  });
  return { path, reason, worldSeconds: seconds(start) };
}

const dev = args.includes("--base") ? args[args.indexOf("--base") + 1] : await devHead();
if (!/^[a-f0-9]{40}$/.test(dev)) throw new Error("--base needs a full pushed commit SHA");
console.log(`base ${dev.slice(0, 9)}: warming its world (as the dev push workflow does)`);
const warm = await prepare(dev, dev);
console.log(`  dev world ${warm.path} in ${warm.worldSeconds}s`);

const workdir = await mkdtemp(join(tmpdir(), "world-check-"));
const branches: string[] = [];
const rows: string[] = [];
let failed = false;
try {
  git(["fetch", "-q", "origin", dev]);
  git(["worktree", "add", "--detach", workdir, dev]);
  for (const scenario of scenarios.filter((entry) => !only || only.has(entry.name))) {
    git(["checkout", "--detach", "--force", dev], workdir);
    await scenario.change(workdir);
    git(["-c", "user.name=world-check", "-c", "user.email=world-check@openwork.invalid", "commit", "-qam", `world check: ${scenario.name} (throwaway)`], workdir);
    const sha = git(["rev-parse", "HEAD"], workdir);
    const branch = `tmp/world-check/${scenario.name}-${stamp}`;
    git(["push", "-q", "origin", `HEAD:refs/heads/${branch}`], workdir);
    branches.push(branch);
    console.log(`\n${scenario.name}: ${sha.slice(0, 9)} (expect ${scenario.expect} path)`);
    let result = "pass";
    let world = { path: "?", reason: "", worldSeconds: 0 };
    let testSeconds = 0;
    try {
      world = await prepare(sha, dev);
      console.log(`  world: ${world.path} in ${world.worldSeconds}s ${world.reason ? `(${world.reason})` : ""}`);
      if (world.path !== scenario.expect) result = `expected ${scenario.expect} path`;
      if (scenario.marker) {
        const live = await freestyleEvidenceWeb(sha);
        try {
          const text = await evalIn(live.app, browserScript(() => document.body.innerText, []));
          if (typeof text !== "string" || !text.includes(scenario.marker)) result = "change not live in the world";
        } finally { await live.stop(); }
      }
      const testStart = performance.now();
      const run = spawnSync(process.execPath, ["evals/bin/evals.mjs", "specs/core-chat.e2e.test.ts", "--local", "--engine", "v1", "--surface", "web"], {
        cwd: root, encoding: "utf8", env: { ...process.env, OPENWORK_EVIDENCE_SOURCE_SHA: sha },
      });
      testSeconds = seconds(testStart);
      if (run.status !== 0) { result = "core journey failed"; console.error(run.stdout.slice(-3000), run.stderr.slice(-2000)); }
    } catch (error) {
      result = `error: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
    }
    if (result !== "pass") failed = true;
    console.log(`  core journey ${testSeconds}s → ${result}`);
    rows.push(`| ${scenario.name} | ${scenario.expect} | ${world.path} | ${world.worldSeconds}s | ${testSeconds}s | ${result} |`);
  }
} finally {
  if (!keep) for (const branch of branches) spawnSync("git", ["push", "-q", "origin", "--delete", branch], { cwd: root });
  spawnSync("git", ["worktree", "remove", "--force", workdir], { cwd: root });
  await rm(workdir, { recursive: true, force: true });
}

const table = `## Freestyle world check (dev ${dev.slice(0, 9)})\n\nDev world: ${warm.path} in ${warm.worldSeconds}s\n\n| Scenario | Expected path | Path | World | Core journey | Result |\n| --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`;
console.log(`\n${table}`);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, table);
if (failed) process.exitCode = 1;
