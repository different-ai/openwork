#!/usr/bin/env node
// Typecheck the shipped code of every workspace package a change can affect:
// packages with a changed file and every package that depends on them. Test
// files are left out (they still run, and fail, in the unit tests), so a type
// nit in a test cannot block a PR while a broken import in shipped code does.
//
// Usage: node .github/scripts/typecheck-shipped.mjs [--base <ref> --head <ref>] [--all] [--list]
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { changedFiles } from "./build-inputs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKSPACES = ["apps", "packages", "ee/apps", "ee/packages"];
const DEPENDENCIES = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
// Changing any of these can change every package's types.
const SHARED = [
  /^package\.json$/, /^pnpm-lock\.yaml$/, /^pnpm-workspace\.yaml$/, /^patches\//, /^tsconfig[^/]*\.json$/,
  /^\.github\/scripts\/(typecheck-shipped|build-inputs)\.mjs$/, /^\.github\/workflows\/quick-check\.yml$/,
];
// Typechecked elsewhere: the SDK needs the generated API contract (Generated
// Den SDK on dev pushes); the desktop runs its Electron check below.
const SKIP = new Set(["@openwork/sdk", "@openwork/desktop"]);
const ELECTRON = "@openwork/desktop";

/** Test sources: never shipped, still run by the unit tests. */
export function isTestFile(path) {
  return /(^|\/)(tests?|__tests__|test-utils?|fixtures)\//.test(path)
    || /\.(test|spec|test-d)\.[cm]?[jt]sx?$/.test(path)
    || /(^|\/)[^/]*\.vitest\.[cm]?[jt]sx?$/.test(path);
}

/** Workspace packages: name -> { dir, scripts, deps }. */
export function workspacePackages(root = ROOT) {
  const packages = new Map();
  for (const parent of WORKSPACES) {
    if (!existsSync(join(root, parent))) continue;
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      const manifest = join(root, parent, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      const body = JSON.parse(readFileSync(manifest, "utf8"));
      if (!body.name) continue;
      const deps = new Set(DEPENDENCIES.flatMap((field) => Object.keys(body[field] ?? {})));
      packages.set(body.name, { name: body.name, dir: `${parent}/${entry.name}`, scripts: body.scripts ?? {}, deps });
    }
  }
  return packages;
}

/** Packages to typecheck for a list of changed paths; null means unknown, so all. */
export function selectPackages(files, packages = workspacePackages()) {
  const all = new Set(packages.keys());
  if (!Array.isArray(files)) return all;
  if (files.some((file) => SHARED.some((pattern) => pattern.test(file)))) return all;
  const changed = new Set();
  for (const file of files) {
    for (const pkg of packages.values()) if (file.startsWith(`${pkg.dir}/`)) changed.add(pkg.name);
  }
  // Every package that depends, directly or transitively, on a changed one.
  let grew = true;
  while (grew) {
    grew = false;
    for (const pkg of packages.values()) {
      if (changed.has(pkg.name)) continue;
      if ([...pkg.deps].some((dep) => changed.has(dep))) { changed.add(pkg.name); grew = true; }
    }
  }
  return changed;
}

/**
 * What a package's `typecheck` script checks: the tsconfig projects of its tsc
 * commands (tsc -p X, default tsconfig.json) and the commands it runs first
 * (for example building a dependency whose types come from its build).
 */
export function typecheckPlan(script) {
  if (typeof script !== "string" || !/\btsc\b/.test(script)) return { prerequisites: [], projects: [] };
  const prerequisites = [];
  const projects = [];
  for (const command of script.split("&&").map((part) => part.trim()).filter(Boolean)) {
    if (!/(^|\s)tsc(\s|$)/.test(command)) {
      if (projects.length) throw new Error(`Unsupported typecheck script (a command after tsc): ${script}`);
      prerequisites.push(command);
      continue;
    }
    const match = /(?:^|\s)(?:-p|--project)\s+(\S+)/.exec(command);
    projects.push(match ? match[1] : "tsconfig.json");
  }
  return { prerequisites, projects };
}

function shippedConfig(ts, project) {
  const read = ts.readConfigFile(project, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(project), undefined, project);
  const files = parsed.fileNames.filter((file) => !isTestFile(relative(ROOT, file)));
  const path = join(dirname(project), ".tsconfig.shipped.json");
  writeFileSync(path, `${JSON.stringify({ extends: `./${relative(dirname(project), project)}`, files, include: [] }, null, 2)}\n`);
  return { path, files: files.length, excluded: parsed.fileNames.length - files.length };
}

function run(command, args, cwd) {
  return new Promise((done) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => done({ code, output, seconds: (performance.now() - started) / 1000 }));
  });
}

async function main(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--all" || argv[index] === "--list") args.set(argv[index].slice(2), true);
    else if (argv[index].startsWith("--")) args.set(argv[index].slice(2), argv[++index]);
  }
  const packages = workspacePackages();
  const files = args.get("all") ? null : changedFiles({ base: args.get("base"), head: args.get("head") ?? "HEAD" });
  if (files === null) console.log("Changed files unknown or --all: typechecking every package.");
  const selected = selectPackages(files, packages);
  const jobs = [];
  const tasks = [];
  for (const name of [...selected].sort()) {
    const pkg = packages.get(name);
    if (SKIP.has(name)) continue;
    const plan = typecheckPlan(pkg.scripts.typecheck);
    for (const project of plan.projects) jobs.push({ name, dir: pkg.dir, project: join(ROOT, pkg.dir, project), prerequisites: plan.prerequisites });
  }
  const electron = selected.has(ELECTRON);
  console.log(`Typechecking shipped code of ${jobs.length} project(s)${electron ? " and Electron main" : ""}.`);
  if (args.get("list")) {
    for (const job of jobs) console.log(`  ${relative(ROOT, job.project)}`);
    return;
  }
  const require = createRequire(pathToFileURL(join(ROOT, "package.json")));
  const ts = require("typescript");
  const written = [];
  try {
    for (const job of jobs) {
      const config = shippedConfig(ts, job.project);
      written.push(config.path);
      const tsc = createRequire(pathToFileURL(join(ROOT, job.dir, "package.json"))).resolve("typescript/bin/tsc");
      // Prerequisites (e.g. building a dependency's declarations) run first, in the package.
      const steps = [...job.prerequisites.map((command) => ["sh", ["-c", command]]), [process.execPath, [tsc, "-p", config.path, "--noEmit", "--pretty", "false"]]];
      tasks.push({ weight: config.files + job.prerequisites.length * 1000, label: `${job.name} (${relative(join(ROOT, job.dir), job.project)}, ${config.excluded} test file(s) left out)`, steps, cwd: join(ROOT, job.dir) });
    }
    if (electron) tasks.push({ weight: Infinity, label: "Electron main against the IPC contract", steps: [["pnpm", ["--filter", ELECTRON, "typecheck:electron"]]], cwd: ROOT });
    // tsc is single-threaded: run the longest projects first, one per core.
    const queue = [...tasks].sort((a, b) => b.weight - a.weight);
    const failures = [];
    const workers = Array.from({ length: Math.max(1, Math.min(queue.length, cpus().length)) }, async () => {
      while (queue.length) {
        const task = queue.shift();
        let result = { code: 0, output: "", seconds: 0 };
        for (const [command, args] of task.steps) {
          const step = await run(command, args, task.cwd);
          result = { code: step.code, output: result.output + step.output, seconds: result.seconds + step.seconds };
          if (step.code !== 0) break;
        }
        console.log(`${result.code === 0 ? "ok  " : "FAIL"} ${result.seconds.toFixed(1)}s ${task.label}`);
        if (result.code !== 0) failures.push({ task, result });
      }
    });
    await Promise.all(workers);
    for (const { task, result } of failures) console.log(`\n::group::${task.label}\n${result.output.trim()}\n::endgroup::`);
    if (failures.length) {
      console.error(`${failures.length} typecheck(s) failed.`);
      process.exitCode = 1;
    }
  } finally {
    for (const path of written) rmSync(path, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
}
