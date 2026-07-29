import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCdpBaseUrl } from "./cdp.ts";
import { denStackDown, ensureDenStack } from "./den-stack.ts";
import { applyManifestToEnv, readEnvManifest } from "./env-manifest.ts";
import { createDaytonaHost } from "./hosts/daytona.ts";
import { createLocalHost } from "./hosts/local.ts";
import { ensureKubeStack, kubeStackDown } from "./kube-stack.ts";
import { missingEnv, loadFlows, runFlow } from "./runner.ts";
import { renderMarkdown } from "./reporters/markdown.ts";
import { renderFrameIndex } from "./reporters/fraimz-html.ts";
import { postPrComment } from "./reporters/pr.ts";
import { scaffoldFlow } from "./voiceover.ts";
import type { EvalMode, EvalReport, FlowStatus } from "./flow.ts";
import type { EnvManifest } from "./env-manifest.ts";
import type { Host } from "./hosts/types.ts";

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(RUNNER_DIR, "..", "..");
const FLOWS_DIR = process.env.OPENWORK_EVAL_FLOWS_DIR?.trim() || join(RUNNER_DIR, "..", "flows");
const DEFAULT_RESULTS_DIR = join(RUNNER_DIR, "..", "results");
const DEFAULT_CDP_CANDIDATES = ["http://127.0.0.1:9825", "http://127.0.0.1:9823"];

export interface HostPlacement {
  defaultHostKind: string;
  daytonaSandboxId: string | null;
}

export interface EvalHosts {
  hosts: Map<string, Host>;
  defaultHostKind: string;
}

interface CliArgs {
  flows: string[];
  all: boolean;
  list: boolean;
  cdpUrl: string | null;
  out: string | null;
  stack: string | null;
  stackDown: boolean;
  kubeProfile: "single-org" | "multi-org";
  images: "published" | "local" | null;
  deleteCluster: boolean;
  scaffold: string | null;
  force: boolean;
  pr: true | string | null;
  help: boolean;
  mode: EvalMode;
  envName: string | null;
}

function readRequiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    flows: [],
    all: false,
    list: false,
    cdpUrl: null,
    out: null,
    stack: null,
    stackDown: false,
    kubeProfile: "single-org",
    images: null,
    deleteCluster: false,
    scaffold: null,
    force: false,
    pr: null,
    help: false,
    mode: "demo",
    envName: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--flow") {
      args.flows.push(readRequiredValue(argv, index, value));
      index += 1;
    } else if (value === "--all") args.all = true;
    else if (value === "--list") args.list = true;
    else if (value === "--cdp-url") {
      args.cdpUrl = readRequiredValue(argv, index, value);
      index += 1;
    } else if (value === "--out") {
      args.out = readRequiredValue(argv, index, value);
      index += 1;
    } else if (value === "--stack") {
      args.stack = readRequiredValue(argv, index, value);
      index += 1;
    } else if (value === "--kube-profile") {
      const profile = readRequiredValue(argv, index, value);
      if (profile !== "single-org" && profile !== "multi-org") {
        throw new Error(`Unknown --kube-profile value: ${profile}. Supported: single-org, multi-org.`);
      }
      args.kubeProfile = profile;
      index += 1;
    } else if (value === "--images") {
      const images = readRequiredValue(argv, index, value);
      if (images !== "published" && images !== "local") {
        throw new Error(`Unknown --images value: ${images}. Supported: published, local.`);
      }
      args.images = images;
      index += 1;
    } else if (value === "--mode") {
      const mode = readRequiredValue(argv, index, value);
      if (mode !== "automation" && mode !== "demo") {
        throw new Error(`Unknown --mode value: ${mode}. Supported: automation, demo.`);
      }
      args.mode = mode;
      index += 1;
    } else if (value === "--env") {
      args.envName = readRequiredValue(argv, index, value);
      index += 1;
    } else if (value === "--stack-down") args.stackDown = true;
    else if (value === "--delete-cluster") args.deleteCluster = true;
    else if (value === "scaffold") {
      args.scaffold = readRequiredValue(argv, index, value);
      index += 1;
    } else if (value === "--force") args.force = true;
    else if (value === "--pr") {
      const next = argv[index + 1];
      if (next && /^\d+$/.test(next)) {
        args.pr = next;
        index += 1;
      } else {
        args.pr = true;
      }
    } else if (value === "--help" || value === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function readFlowSource(flowId: string): Promise<string | null> {
  for (const extension of [".flow.ts", ".flow.mjs"]) {
    try {
      return await readFile(join(FLOWS_DIR, `${flowId}${extension}`), "utf8");
    } catch {
      // Try the next supported flow extension.
    }
  }
  return null;
}

async function selectedStackNeedsApp(args: CliArgs): Promise<boolean> {
  if (args.list) return false;
  if (args.all || args.flows.length === 0) return true;
  for (const flowId of args.flows) {
    const source = await readFlowSource(flowId);
    if (!source || !/requiresApp\s*:\s*false/.test(source)) return true;
  }
  return false;
}

function incrementSummary(summary: Record<FlowStatus, number>, status: FlowStatus): void {
  if (status === "passed") summary.passed += 1;
  else if (status === "failed") summary.failed += 1;
  else summary.skipped += 1;
}

function manifestDaytonaSandbox(manifest: EnvManifest | null): string | null {
  if (!manifest) return null;
  for (const handle of Object.values(manifest.surfaces)) {
    if (handle.hostKind === "daytona") {
      const sandbox = handle.sandboxId?.trim();
      if (sandbox) return sandbox;
    }
  }
  return manifest.env?.OPENWORK_EVAL_DAYTONA_SANDBOX?.trim() || null;
}

export function resolveHostPlacement(manifest: EnvManifest | null, env: NodeJS.ProcessEnv = process.env): HostPlacement {
  const daytonaSandboxId = manifestDaytonaSandbox(manifest) ?? (env.OPENWORK_EVAL_DAYTONA_SANDBOX?.trim() || null);
  return {
    daytonaSandboxId,
    defaultHostKind: manifest?.defaultHostKind ?? (daytonaSandboxId ? "daytona" : "local"),
  };
}

function daytonaReservedPorts(manifest: EnvManifest | null, kind: "chrome" | "electron"): number[] {
  if (!manifest) return [];
  const ports: number[] = [];
  for (const handle of Object.values(manifest.surfaces)) {
    const rawPort = handle.hostKind === "daytona" && handle.kind === kind ? handle.meta?.cdpPort : undefined;
    if (!rawPort || !/^\d+$/.test(rawPort)) continue;
    const port = Number.parseInt(rawPort, 10);
    if (port > 0 && port <= 65_535) ports.push(port);
  }
  return ports;
}

export function createEvalHosts({ manifest, env, repoRoot, log }: { manifest: EnvManifest | null; env: NodeJS.ProcessEnv; repoRoot: string; log: (msg: string) => void }): EvalHosts {
  const placement = resolveHostPlacement(manifest, env);
  const hosts = new Map<string, Host>([["local", createLocalHost({ repoRoot, log })]]);
  if (placement.daytonaSandboxId) {
    hosts.set("daytona", createDaytonaHost({
      sandboxId: placement.daytonaSandboxId,
      log,
      repoRoot,
      reservedChromePorts: daytonaReservedPorts(manifest, "chrome"),
      reservedElectronPorts: daytonaReservedPorts(manifest, "electron"),
    }));
  }
  return { hosts, defaultHostKind: placement.defaultHostKind };
}

function printHelp(): void {
  console.log("Usage: node evals/runner/run.mjs [--mode automation|demo] [--list | --all | --flow <id> ... | scaffold <id> [--force]] [--cdp-url <url>] [--env <name>] [--out <dir>] [--pr [number]] [--stack den|kube] [--kube-profile single-org|multi-org] [--images published|local] [--stack-down [--delete-cluster]]");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  if (args.stackDown) {
    await denStackDown({ log: (msg) => console.log(`▸ ${msg}`) });
    await kubeStackDown({ log: (msg) => console.log(`▸ ${msg}`), deleteCluster: args.deleteCluster });
    return;
  }

  if (args.scaffold) {
    const { flowPath, frames, narrated } = await scaffoldFlow(args.scaffold, { flowsDir: FLOWS_DIR, force: args.force, mode: args.mode });
    if (narrated) {
      console.log(`Scaffolded ${flowPath} — ${frames} frames from evals/voiceovers/${args.scaffold}.md.`);
    } else {
      console.log(`Scaffolded ${flowPath} — plain automation stub (no voice-over script).`);
    }
    console.log("Fill in each frame's action/assert, then run: pnpm fraimz --flow " + args.scaffold);
    return;
  }

  let manifest: EnvManifest | null = null;
  if (args.envName) {
    manifest = await readEnvManifest(args.envName);
    if (!manifest) throw new Error(`Env manifest not found: ${args.envName}`);
    applyManifestToEnv(manifest, process.env);
  }

  if (args.stack === "den") {
    await ensureDenStack({
      log: (msg) => console.log(`▸ ${msg}`),
      cdpCandidates: args.cdpUrl ? [args.cdpUrl] : DEFAULT_CDP_CANDIDATES,
      skipApp: !(await selectedStackNeedsApp(args)),
    });
  } else if (args.stack === "kube") {
    await ensureKubeStack({
      log: (msg) => console.log(`▸ ${msg}`),
      cdpCandidates: args.cdpUrl ? [args.cdpUrl] : DEFAULT_CDP_CANDIDATES,
      skipApp: !(await selectedStackNeedsApp(args)),
      profile: args.kubeProfile,
      images: args.images ?? undefined,
    });
  } else if (args.stack) {
    throw new Error(`Unknown stack: ${args.stack}. Supported: den, kube`);
  }

  const flows = await loadFlows(FLOWS_DIR);

  if (args.list) {
    for (const flow of flows) {
      const gates = flow.requiredEnv?.length ? ` (requires env: ${flow.requiredEnv.join(", ")})` : "";
      console.log(`${flow.id} — ${flow.title}${gates}`);
    }
    return;
  }

  const selected = args.all
    ? flows
    : flows.filter((flow) => args.flows.includes(flow.id));
  if (selected.length === 0) {
    throw new Error(
      args.flows.length > 0
        ? `No flows matched: ${args.flows.join(", ")}. Use --list to see available flows.`
        : "Nothing to run. Pass --all, or --flow <id>. Use --list to see available flows.",
    );
  }

  // App-less flows (requiresApp: false) don't need a CDP endpoint; only probe
  // for one when at least one selected flow drives the app.
  const needsApp = selected.some((flow) => missingEnv(flow, process.env).length === 0 && flow.requiresApp !== false);
  const envCdp = process.env.OPENWORK_EVAL_CDP_URL?.trim();
  const cdpBaseUrl = args.cdpUrl
    ?? (envCdp || (needsApp ? await resolveCdpBaseUrl(DEFAULT_CDP_CANDIDATES) : null));

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(args.out ?? DEFAULT_RESULTS_DIR, runId);
  await mkdir(outDir, { recursive: true });

  const report: EvalReport = {
    runId,
    startedAt: new Date().toISOString(),
    cdpUrl: cdpBaseUrl ?? "(app-less run)",
    mode: args.mode,
    flows: [],
    summary: { passed: 0, failed: 0, skipped: 0 },
  };
  const { hosts, defaultHostKind } = createEvalHosts({
    manifest,
    env: process.env,
    repoRoot: REPO_ROOT,
    log: (msg) => console.log(`▸ ${msg}`),
  });

  for (const flow of selected) {
    console.log(`▶ ${flow.id} — ${flow.title}`);
    const result = await runFlow(flow, { cdpBaseUrl, outDir, env: process.env, mode: args.mode, hosts, defaultHostKind, manifest });
    report.flows.push(result);
    incrementSummary(report.summary, result.status);
    for (const step of result.steps) {
      const icon = step.status === "passed" ? "  ✓" : "  ✗";
      console.log(`${icon} ${step.name} (${step.durationMs}ms)${step.error ? ` — ${step.error}` : ""}`);
    }
    if (result.skipReason) console.log(`  ⏭ skipped: ${result.skipReason}`);
  }

  report.finishedAt = new Date().toISOString();
  await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(outDir, "report.md"), renderMarkdown(report));
  // fraimz.html is the canonical human-readable artifact (frame-by-frame proof:
  // claim + action + assertion + screenshot per step). `index.html` is kept as
  // a back-compat alias.
  const fraimz = renderFrameIndex(report);
  await writeFile(join(outDir, "fraimz.html"), fraimz);
  await writeFile(join(outDir, "index.html"), fraimz);

  console.log("");
  console.log(
    `Result: ${report.summary.failed > 0 ? "FAILED" : "PASSED"} — ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped`,
  );
  console.log(`Report: ${join(outDir, "report.md")}`);
  console.log(`fraimz: ${join(outDir, "fraimz.html")}`);

  // fraimz on the PR: post the frame-by-frame proof as a comment. `--pr`
  // targets the current branch's PR; `--pr <number>` targets an explicit one.
  if (args.pr) {
    const { posted, bodyPath, detail } = await postPrComment(report, {
      outDir,
      prNumber: args.pr === true ? null : args.pr,
    });
    console.log(posted ? `PR comment posted: ${detail}` : `PR comment NOT posted (${detail}). Body written to ${bodyPath}`);
  }

  if (report.summary.failed > 0) process.exit(1);
}
