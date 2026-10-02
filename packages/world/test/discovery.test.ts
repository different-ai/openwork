import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { main } from "../src/cli.ts";
import type { PreflightCheck } from "../src/preflight.ts";
import { fixtureRepo } from "./git-fixture.ts";

const REPO_WORLDS = fileURLToPath(new URL("../../../worlds", import.meta.url));
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

function keyCheck(read: () => string | undefined): PreflightCheck {
  return {
    id: "fixture-key",
    label: "FIXTURE_KEY",
    places: ["freestyle"],
    blocking: true,
    needs: "FIXTURE_KEY in this command's environment.",
    fix: "prefix the command with FIXTURE_KEY=…",
    async run({ command }) {
      return read()
        ? { ok: true }
        : { ok: false, detail: "FIXTURE_KEY is not set", hint: command ? `FIXTURE_KEY=… ${command}` : "prefix the command with FIXTURE_KEY=…" };
    },
  };
}

test("an unmet requirement stops up before anything is created and prints a rerunnable fix", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-requirements-"));
  const worldsDirectory = join(root, "worlds");
  let otherPlacementChecks = 0;
  try {
    await mkdir(worldsDirectory);
    await writeFile(join(worldsDirectory, "keyed.ts"), 'export const supportedTargets = ["local/host", "freestyle/linux"];\nthrow new Error("script was launched");\n');
    const lines: string[] = [];
    const code = await main(["up", "keyed", "--place", "freestyle", "--stage", "two words", "--detach"], {
      cwd: root,
      worldsDirectory,
      preflight: [
        keyCheck(() => undefined),
        { id: "login", label: "login", places: ["daytona"], blocking: true, async run() { otherPlacementChecks += 1; return { ok: false }; } },
        { id: "badge", label: "badge", places: ["local"], async run() { otherPlacementChecks += 1; return { ok: false }; } },
      ],
      print: (line) => lines.push(line),
      progress: () => {},
    });
    assert.equal(code, 1);
    assert.deepEqual(lines, [
      "keyed cannot start on freestyle/linux: a requirement is not met. Nothing was created.",
      "  ✖ FIXTURE_KEY: FIXTURE_KEY is not set",
      "    fix: FIXTURE_KEY=… pnpm world up keyed --place freestyle --stage 'two words' --detach",
    ]);
    assert.equal(otherPlacementChecks, 0, "checks for other placements do not run");
    const scripts = join(root, "evals", "results", ".worlds", "scripts");
    assert.equal(await exists(join(scripts, "keyed--two-words.json")), false, "no receipt");
    assert.equal(await exists(join(scripts, "keyed--two-words.log")), false, "the script never started");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a requirement that times out warns without blocking up", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-requirement-timeout-"));
  const worldsDirectory = join(root, "worlds");
  const holdUrl = new URL("../src/hold.ts", import.meta.url).href;
  const options = { cwd: root, worldsDirectory, print: () => {}, progress: () => {} };
  try {
    await mkdir(worldsDirectory);
    await writeFile(join(worldsDirectory, "slow.ts"), `import { hold } from ${JSON.stringify(holdUrl)};\nawait hold({ name: "slow", outputs: { ready: "yes" } });\n`);
    const progress: string[] = [];
    assert.equal(await main(["up", "slow", "--detach"], {
      ...options,
      preflight: [{ id: "login", label: "slow login", blocking: true, timeoutMs: 10, async run() { await delay(200); return { ok: true }; } }],
      progress: (line) => progress.push(line),
    }), 0);
    assert.ok(progress.includes("⚠ slow login timed out"), progress.join("\n"));
  } finally {
    await main(["down", "slow"], options);
    await rm(root, { recursive: true, force: true });
  }
});

test("plan checks only the target's requirements, reports the fix, and fails while one is unmet", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-plan-requirements-"));
  const worldsDirectory = join(root, "worlds");
  let key: string | undefined;
  let badgeRuns = 0;
  const preflight: PreflightCheck[] = [
    keyCheck(() => key),
    { id: "badge", label: "badge", async run() { badgeRuns += 1; return { ok: false }; } },
  ];
  try {
    await mkdir(worldsDirectory);
    await writeFile(join(worldsDirectory, "keyed.ts"), 'export const supportedTargets = ["local/host", "freestyle/linux"];\nthrow new Error("script was launched");\n');
    const lines: string[] = [];
    const options = { cwd: root, worldsDirectory, preflight, print: (line: string) => { lines.push(line); }, progress: () => {} };
    assert.equal(await main(["plan", "keyed", "--place", "freestyle", "--stage", "demo"], options), 1);
    assert.equal(lines[0], "+ create");
    assert.ok(lines.includes("target  freestyle/linux"));
    assert.ok(lines.includes("requires  FIXTURE_KEY ✖"));
    assert.ok(lines.includes("  ✖ FIXTURE_KEY: FIXTURE_KEY is not set"));
    assert.ok(lines.includes("    fix: prefix the command with FIXTURE_KEY=…"));
    assert.equal(lines.at(-1), "keyed cannot start on freestyle/linux until this requirement is met.");

    lines.length = 0;
    assert.equal(await main(["plan", "keyed", "--place", "freestyle", "--stage", "demo", "--json"], options), 1);
    const plan: unknown = JSON.parse(lines.join(""));
    assert.deepEqual(plan, {
      name: "keyed--demo",
      stage: "demo",
      target: "freestyle/linux",
      state: "create",
      receipt: join(root, "evals", "results", ".worlds", "scripts", "keyed--demo.json"),
      ready: false,
      requirements: [{ id: "fixture-key", label: "FIXTURE_KEY", ok: false, detail: "FIXTURE_KEY is not set", fix: "prefix the command with FIXTURE_KEY=…" }],
    });

    key = "set";
    lines.length = 0;
    assert.equal(await main(["plan", "keyed", "--place", "freestyle", "--stage", "demo", "--json"], options), 0);
    const ready: unknown = JSON.parse(lines.join(""));
    assert.ok(typeof ready === "object" && ready !== null && "ready" in ready && ready.ready === true);

    lines.length = 0;
    assert.equal(await main(["plan", "keyed", "--stage", "demo"], options), 0, "no requirement applies locally");
    assert.deepEqual(lines, ["+ create", `receipt  ${join(root, "evals", "results", ".worlds", "scripts", "keyed--demo.json")}`]);

    lines.length = 0;
    assert.equal(await main(["plan", "keyed", "--place", "daytona"], options), 1);
    assert.match(lines.join("\n"), /cannot run on daytona\/linux/);
    assert.equal(badgeRuns, 0, "health badges never run in plan");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("help --json describes a maintained world's targets, seeds, requirements and runnable examples", async () => {
  const lines: string[] = [];
  const preflight: PreflightCheck[] = [
    { id: "badge", label: "badge", places: ["local"], async run() { return { ok: true }; } },
    { id: "daytona", label: "daytona login", places: ["daytona"], blocking: true, needs: "A logged-in Daytona CLI.", fix: "daytona login", async run() { return { ok: true }; } },
    { id: "freestyle", label: "FREESTYLE_API_KEY", places: ["freestyle"], blocking: true, needs: "FREESTYLE_API_KEY.", fix: "prefix the command", async run() { return { ok: true }; } },
  ];
  const options = { cwd: fileURLToPath(new URL("../../..", import.meta.url)), worldsDirectory: REPO_WORLDS, preflight, print: (line: string) => { lines.push(line); } };
  assert.equal(await main(["help", "preview-desktop", "--json"], options), 0);
  const info: unknown = JSON.parse(lines.join(""));
  assert.ok(typeof info === "object" && info !== null);
  const record = new Map(Object.entries(info));
  assert.equal(record.get("name"), "preview-desktop");
  assert.equal(typeof record.get("summary"), "string");
  assert.deepEqual(record.get("seeds"), ["fresh", "blank"]);
  assert.deepEqual(record.get("sources"), ["desktop"]);
  const targets = record.get("targets");
  assert.ok(Array.isArray(targets));
  const byTarget = new Map(targets.map((entry: { target: string }) => [entry.target, entry]));
  assert.deepEqual([...byTarget.keys()], ["local/host", "daytona/linux", "daytona/windows", "freestyle/linux"]);
  assert.deepEqual(byTarget.get("freestyle/linux"), {
    target: "freestyle/linux",
    seeds: ["fresh"],
    sources: ["sha", "ref"],
    defaultSource: "ref:dev: the current origin/dev commit, pinned to its full SHA at launch (the source the alpha channel is built from)",
    note: "Signed-out desktop snapshot of a pushed commit: no Den, releases or --env app settings.",
    requires: ["freestyle"],
  });
  assert.deepEqual(new Map(Object.entries(byTarget.get("daytona/windows") ?? {})).get("requires"), ["daytona"]);
  assert.deepEqual(new Map(Object.entries(byTarget.get("local/host") ?? {})).get("requires"), []);
  assert.deepEqual(Object.keys(record.get("seedMeanings") ?? {}), ["fresh", "blank"]);
  assert.deepEqual(record.get("requirements"), [
    { id: "daytona", label: "daytona login", places: ["daytona"], needs: "A logged-in Daytona CLI.", fix: "daytona login" },
    { id: "freestyle", label: "FREESTYLE_API_KEY", places: ["freestyle"], needs: "FREESTYLE_API_KEY.", fix: "prefix the command" },
  ]);
  const examples = record.get("examples");
  assert.ok(Array.isArray(examples) && examples.length > 0);
  assert.ok(Object.keys(record.get("placeholders") ?? {}).includes("<stage>"));

  lines.length = 0;
  assert.equal(await main(["help", "preview-desktop"], options), 0);
  const text = lines.join("\n");
  assert.match(text, /^preview-desktop: worlds\/preview-desktop\.ts$/m);
  assert.match(text, /^Seeds: fresh, blank$/m, "existing summary lines stay");
  assert.match(text, /freestyle\/linux: seeds fresh; sources sha, ref; requires freestyle/);
  assert.match(text, /omitted --source: ref:dev/);
  assert.match(text, /pnpm world up preview-desktop --place freestyle --stage <stage>/);

  lines.length = 0;
  assert.equal(await main(["help", "--json"], options), 0);
  const all: unknown = JSON.parse(lines.join(""));
  assert.ok(Array.isArray(all) && all.length > 0);
  for (const entry of all) {
    assert.ok(typeof entry === "object" && entry !== null && "summary" in entry && typeof entry.summary === "string" && entry.summary.length > 0, `${JSON.stringify(entry)} declares a summary`);
  }
});

test("list --json and outputs --json answer with structured data, including a missing world", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-json-"));
  const worldsDirectory = join(root, "worlds");
  try {
    await mkdir(worldsDirectory);
    await writeFile(join(worldsDirectory, "described.ts"), 'export const summary = "A described fixture.";\nexport const supportedTargets = ["local/host"];\n');
    const lines: string[] = [];
    const options = { cwd: root, worldsDirectory, print: (line: string) => { lines.push(line); } };
    assert.equal(await main(["list", "--json"], options), 0);
    assert.deepEqual(JSON.parse(lines.join("")), {
      worlds: [{ name: "described", path: join("worlds", "described.ts"), supportedTargets: ["local/host"], summary: "A described fixture." }],
      receipts: [],
    });
    lines.length = 0;
    assert.equal(await main(["outputs", "described", "--stage", "nope", "--json"], options), 1);
    assert.deepEqual(JSON.parse(lines.join("")), { name: "described--nope", exists: false });
    lines.length = 0;
    assert.equal(await main(["outputs", "described", "--stage", "nope"], options), 1);
    assert.deepEqual(lines, ['World receipt "described--nope" does not exist.']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("up refuses a seed the target cannot apply and names where that seed is available", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-seed-pointer-"));
  try {
    const lines: string[] = [];
    const options = { cwd: root, worldsDirectory: REPO_WORLDS, print: (line: string) => { lines.push(line); }, progress: () => {} };
    assert.equal(await main(["up", "preview-desktop", "--place", "freestyle", "--seed", "workspace"], options), 1);
    assert.equal(lines.join("\n"), 'preview-desktop on freestyle/linux accepts --seed fresh; "workspace" is not available here. workspace is available in: preview-den on local/host, daytona/linux; preview-full on local/host, daytona/linux. See pnpm world help preview-desktop.');
    lines.length = 0;
    assert.equal(await main(["up", "preview-app-web", "--seed", "fresh"], options), 1);
    assert.match(lines.join("\n"), /^preview-app-web on local\/(macos|linux|windows) takes no --seed; "fresh" is not available here\. fresh is available in: preview-desktop on local\/host, daytona\/linux, freestyle\/linux;/);
    assert.equal(await exists(join(root, "evals")), false, "nothing was created");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan shows who a passing requirement uses, and warns without blocking", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-plan-warning-"));
  const worldsDirectory = join(root, "worlds");
  try {
    await mkdir(worldsDirectory);
    await writeFile(join(worldsDirectory, "keyed.ts"), 'export const supportedTargets = ["local/host", "freestyle/linux"];\n');
    const preflight: PreflightCheck[] = [
      { id: "login", label: "login", places: ["freestyle"], blocking: true, async run() { return { ok: true, warning: true, detail: "using a personal organization", hint: "use the team key" }; } },
      { id: "identity", label: "identity", places: ["freestyle"], blocking: true, async run() { return { ok: true, detail: "using the team key" }; } },
    ];
    const lines: string[] = [];
    const options = { cwd: root, worldsDirectory, preflight, print: (line: string) => { lines.push(line); }, progress: () => {} };
    assert.equal(await main(["plan", "keyed", "--place", "freestyle"], options), 0, "warnings never block");
    assert.ok(lines.includes("requires  login ⚠  identity ✔"), lines.join("\n"));
    assert.ok(lines.includes("  ⚠ login: using a personal organization"));
    assert.ok(lines.includes("    fix: use the team key"));
    assert.ok(lines.includes("  identity: using the team key"), "a passing requirement still says who");
    lines.length = 0;
    assert.equal(await main(["plan", "keyed", "--place", "freestyle", "--json"], options), 0);
    const plan: unknown = JSON.parse(lines.join(""));
    assert.ok(typeof plan === "object" && plan !== null && "ready" in plan && plan.ready === true && "requirements" in plan && Array.isArray(plan.requirements));
    assert.deepEqual(plan.requirements[0], { id: "login", label: "login", ok: true, detail: "using a personal organization", fix: "use the team key", warning: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("up names the source commit and warns when this checkout's recipes are not that commit's", async () => {
  const { root, sha } = await fixtureRepo();
  const previous = process.env.OPENWORK_EVAL_REF;
  process.env.OPENWORK_EVAL_REF = sha;
  try {
    await writeFile(join(root, "worlds", "remote.ts"), 'export const supportedTargets = ["local/host", "daytona/linux"];\n// local edit\n');
    const lines: string[] = [];
    const code = await main(["up", "remote", "--place", "daytona", "--detach"], {
      cwd: root,
      worldsDirectory: join(root, "worlds"),
      recipePaths: ["worlds"],
      preflight: [{ id: "login", label: "login", places: ["daytona"], blocking: true, async run() { return { ok: false, detail: "not logged in" }; } }],
      print: (line) => lines.push(line),
      progress: () => {},
    });
    assert.equal(code, 1);
    const short = sha.slice(0, 9);
    assert.deepEqual(lines, [
      "remote cannot start on daytona/linux: a requirement is not met. Nothing was created.",
      "  ✖ login: not logged in",
      `source  ${short} feat: fixture world recipe`,
      `note  this checkout's world recipes differ from ${short} in 1 file; the driver runs from this checkout (${short} on main), not from ${short}. For that commit's recipes, run from a worktree: git worktree add ../openwork-${short} ${short}`,
    ]);
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_EVAL_REF;
    else process.env.OPENWORK_EVAL_REF = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed world gets the fix for a recognised provider failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-diagnose-"));
  const worldsDirectory = join(root, "worlds");
  try {
    await mkdir(worldsDirectory);
    await writeFile(join(worldsDirectory, "quota.ts"), 'console.log("Bad Request: Total memory limit exceeded. Maximum allowed: 10GiB.");\nprocess.exit(1);\n');
    const progress: string[] = [];
    const code = await main(["up", "quota", "--detach"], {
      cwd: root,
      worldsDirectory,
      diagnose: (text) => text.includes("Total memory limit exceeded") ? ["free memory in that organization"] : [],
      print: () => {},
      progress: (line) => progress.push(line),
    }).catch(() => 1);
    assert.equal(code, 1);
    assert.ok(progress.includes("hint: free memory in that organization"), progress.join("\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
