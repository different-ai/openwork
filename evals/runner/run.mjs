#!/usr/bin/env node
/**
 * OpenWork eval runner.
 *
 * Executes coded eval flows (evals/flows/*.flow.mjs) against a live app over
 * CDP, with machine-checkable assertions and JSON + markdown reports.
 *
 * Usage:
 *   node evals/runner/run.mjs --list
 *   node evals/runner/run.mjs --flow app-smoke [--flow another]
 *   node evals/runner/run.mjs --all
 *   node evals/runner/run.mjs --all --cdp-url http://127.0.0.1:9825
 *
 * The CDP endpoint defaults to probing http://127.0.0.1:9825 (Daytona) then
 * http://127.0.0.1:9823 (local pnpm dev). Override with --cdp-url or
 * OPENWORK_EVAL_CDP_URL.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { connect, pickAppTarget, resolveCdpBaseUrl } from "./cdp.mjs";
import { EvalContext } from "./context.mjs";

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
const FLOWS_DIR = join(RUNNER_DIR, "..", "flows");
const DEFAULT_RESULTS_DIR = join(RUNNER_DIR, "..", "results");
const DEFAULT_CDP_CANDIDATES = ["http://127.0.0.1:9825", "http://127.0.0.1:9823"];

function parseArgs(argv) {
  const args = { flows: [], all: false, list: false, cdpUrl: null, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--flow") args.flows.push(argv[++index]);
    else if (value === "--all") args.all = true;
    else if (value === "--list") args.list = true;
    else if (value === "--cdp-url") args.cdpUrl = argv[++index];
    else if (value === "--out") args.out = argv[++index];
    else if (value === "--help" || value === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function loadFlows() {
  const entries = await readdir(FLOWS_DIR);
  const flows = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".flow.mjs")) continue;
    const module = await import(pathToFileURL(join(FLOWS_DIR, entry)).href);
    const flow = module.default;
    if (!flow?.id || !Array.isArray(flow.steps)) {
      throw new Error(`Flow file ${entry} must default-export { id, title, steps }.`);
    }
    flows.push({ ...flow, file: entry });
  }
  return flows;
}

function missingEnv(flow, env) {
  return (flow.requiredEnv ?? []).filter((name) => !env[name]?.trim());
}

async function runFlow(flow, { cdpBaseUrl, outDir, env }) {
  const result = {
    id: flow.id,
    title: flow.title,
    spec: flow.spec ?? null,
    status: "passed",
    skipReason: null,
    steps: [],
    logs: [],
  };

  const missing = missingEnv(flow, env);
  if (missing.length > 0) {
    result.status = "skipped";
    result.skipReason = `Missing env: ${missing.join(", ")}`;
    return result;
  }

  const target = await pickAppTarget(cdpBaseUrl);
  const client = await connect(target.webSocketDebuggerUrl);
  const ctx = new EvalContext({ client, outDir, flowId: flow.id, env });

  try {
    for (const step of flow.steps) {
      const stepResult = { name: step.name, status: "passed", durationMs: 0, error: null };
      const startedAt = Date.now();
      try {
        await step.run(ctx);
      } catch (error) {
        stepResult.status = "failed";
        stepResult.error = error instanceof Error ? error.message : String(error);
        result.status = "failed";
      }
      stepResult.durationMs = Date.now() - startedAt;
      result.steps.push(stepResult);
      if (stepResult.status === "failed") {
        await ctx.screenshot("failure").catch(() => undefined);
        break;
      }
    }
  } finally {
    result.screenshots = ctx.screenshots;
    result.logs = ctx.logs;
    client.close();
  }

  return result;
}

function renderMarkdown(report) {
  const lines = [
    `# Eval run ${report.runId}`,
    "",
    `- Started: ${report.startedAt}`,
    `- CDP: ${report.cdpUrl}`,
    `- Result: ${report.summary.failed > 0 ? "FAILED" : "PASSED"} (${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped)`,
    "",
  ];
  for (const flow of report.flows) {
    const icon = flow.status === "passed" ? "✅" : flow.status === "skipped" ? "⏭️" : "❌";
    lines.push(`## ${icon} ${flow.id} — ${flow.title}`);
    if (flow.spec) lines.push(`Spec: ${flow.spec}`);
    if (flow.skipReason) lines.push(`Skipped: ${flow.skipReason}`);
    lines.push("");
    for (const step of flow.steps ?? []) {
      const stepIcon = step.status === "passed" ? "✅" : "❌";
      lines.push(`- ${stepIcon} ${step.name} (${step.durationMs}ms)${step.error ? ` — ${step.error}` : ""}`);
    }
    if (flow.screenshots?.length) {
      lines.push("", `Screenshots: ${flow.screenshots.join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node evals/runner/run.mjs [--list | --all | --flow <id> ...] [--cdp-url <url>] [--out <dir>]");
    return;
  }

  const flows = await loadFlows();

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

  const envCdp = process.env.OPENWORK_EVAL_CDP_URL?.trim();
  const cdpBaseUrl = args.cdpUrl ?? (envCdp || (await resolveCdpBaseUrl(DEFAULT_CDP_CANDIDATES)));

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(args.out ?? DEFAULT_RESULTS_DIR, runId);
  await mkdir(outDir, { recursive: true });

  const report = {
    runId,
    startedAt: new Date().toISOString(),
    cdpUrl: cdpBaseUrl,
    flows: [],
    summary: { passed: 0, failed: 0, skipped: 0 },
  };

  for (const flow of selected) {
    console.log(`▶ ${flow.id} — ${flow.title}`);
    const result = await runFlow(flow, { cdpBaseUrl, outDir, env: process.env });
    report.flows.push(result);
    report.summary[result.status] += 1;
    for (const step of result.steps) {
      const icon = step.status === "passed" ? "  ✓" : "  ✗";
      console.log(`${icon} ${step.name} (${step.durationMs}ms)${step.error ? ` — ${step.error}` : ""}`);
    }
    if (result.skipReason) console.log(`  ⏭ skipped: ${result.skipReason}`);
  }

  report.finishedAt = new Date().toISOString();
  await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(outDir, "report.md"), renderMarkdown(report));

  console.log("");
  console.log(
    `Result: ${report.summary.failed > 0 ? "FAILED" : "PASSED"} — ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped`,
  );
  console.log(`Report: ${join(outDir, "report.md")}`);

  if (report.summary.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
