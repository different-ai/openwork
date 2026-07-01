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
 *   node evals/runner/run.mjs --all --stack den   # bring up MySQL + den-api +
 *                                                 # seed + app, mint demo creds
 *   node evals/runner/run.mjs --stack-down        # stop what --stack started
 *
 * The CDP endpoint defaults to probing http://127.0.0.1:9825 (Daytona) then
 * http://127.0.0.1:9823 (local pnpm dev). Override with --cdp-url or
 * OPENWORK_EVAL_CDP_URL.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { connect, debuggerUrlFor, pickAppTarget, resolveCdpBaseUrl } from "./cdp.mjs";
import { EvalContext } from "./context.mjs";
import { denStackDown, ensureDenStack } from "./den-stack.mjs";

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
const FLOWS_DIR = join(RUNNER_DIR, "..", "flows");
const DEFAULT_RESULTS_DIR = join(RUNNER_DIR, "..", "results");
const DEFAULT_CDP_CANDIDATES = ["http://127.0.0.1:9825", "http://127.0.0.1:9823"];

function parseArgs(argv) {
  const args = { flows: [], all: false, list: false, cdpUrl: null, out: null, stack: null, stackDown: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--flow") args.flows.push(argv[++index]);
    else if (value === "--all") args.all = true;
    else if (value === "--list") args.list = true;
    else if (value === "--cdp-url") args.cdpUrl = argv[++index];
    else if (value === "--out") args.out = argv[++index];
    else if (value === "--stack") args.stack = argv[++index];
    else if (value === "--stack-down") args.stackDown = true;
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
  const client = await connect(debuggerUrlFor(cdpBaseUrl, target));
  const ctx = new EvalContext({ client, outDir, flowId: flow.id, env });

  try {
    // Force light mode by default so screenshot evidence is readable. Flows
    // that are themselves testing theme/dark-mode behavior can opt out with
    // `preserveTheme: true` in the flow definition.
    if (!flow.preserveTheme) {
      try {
        await ctx.ensureLightMode();
      } catch (error) {
        ctx.log(`Could not force light mode (continuing anyway): ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (typeof flow.precondition === "function") {
      const startedAt = Date.now();
      try {
        const skipReason = await flow.precondition(ctx);
        if (skipReason) {
          result.status = "skipped";
          result.skipReason = String(skipReason);
          return result;
        }
      } catch (error) {
        result.status = "failed";
        result.steps.push({
          name: "Precondition",
          status: "failed",
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        await ctx.screenshot("failure").catch(() => undefined);
        return result;
      }
    }
    for (const step of flow.steps) {
      const stepResult = { name: step.name, status: "passed", durationMs: 0, error: null, evidence: [] };
      const startedAt = Date.now();
      ctx.beginStep(step.name);
      try {
        await step.run(ctx);
      } catch (error) {
        stepResult.status = "failed";
        stepResult.error = error instanceof Error ? error.message : String(error);
        result.status = "failed";
      } finally {
        stepResult.evidence = ctx.endStep();
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
    result.evidenceFrames = ctx.evidenceFrames;
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
    `- fraimz: fraimz.html`,
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
      for (const evidence of step.evidence ?? []) {
        if (evidence.type === "frame") lines.push(`  - Frame: ${evidence.file} (${evidence.status})`);
        if (evidence.type === "assertion") lines.push(`  - Assertion: ${evidence.assertion} (${evidence.status})`);
      }
    }
    if (flow.screenshots?.length) {
      lines.push("", `Screenshots: ${flow.screenshots.join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderFrameIndex(report) {
  const flowSections = report.flows.map((flow) => {
    const steps = (flow.steps ?? []).map((step) => `
        <article class="step ${step.status === "passed" ? "passed" : "failed"}">
          <header>
            <div class="eyebrow">${escapeHtml(step.status.toUpperCase())} · ${Number(step.durationMs) || 0}ms</div>
            <h3>${escapeHtml(step.name)}</h3>
            ${step.error ? `<div class="error">${escapeHtml(step.error)}</div>` : ""}
          </header>
          ${renderEvidence(step.evidence ?? [])}
        </article>`).join("\n");
    return `
      <section>
        <h2>${escapeHtml(flow.id)} - ${escapeHtml(flow.title)}</h2>
        ${flow.spec ? `<p class="muted">Spec: ${escapeHtml(flow.spec)}</p>` : ""}
        ${flow.skipReason ? `<p class="skipped">Skipped: ${escapeHtml(flow.skipReason)}</p>` : ""}
        <div class="steps">${steps}</div>
      </section>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>fraimz · OpenWork Eval Run ${escapeHtml(report.runId)}</title>
  <style>
    body { margin: 0; background: #f7f7f8; color: #171717; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 1180px; margin: 0 auto; padding: 32px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    h2 { margin-top: 32px; }
    h3 { margin: 2px 0 10px; font-size: 18px; }
    .meta, .muted { color: #5f6368; }
    .summary { display: inline-flex; gap: 12px; margin: 16px 0 8px; padding: 10px 12px; border: 1px solid #ddd; border-radius: 10px; background: white; }
    .steps { display: grid; gap: 18px; margin-top: 16px; }
    .step { padding: 16px; border: 1px solid #ddd; border-radius: 14px; background: white; box-shadow: 0 1px 4px rgba(0,0,0,.04); }
    .step.failed { border-color: #f4b4ae; background: #fff8f7; }
    .eyebrow { color: #5f6368; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .evidence { display: grid; gap: 12px; }
    .claim { padding: 10px 12px; border-left: 4px solid #7c3aed; background: #f5f3ff; border-radius: 8px; }
    .assertions, .validations { margin: 8px 0 0; padding-left: 20px; }
    .assertions li, .validations li { margin: 5px 0; }
    figure { margin: 0; overflow: hidden; border: 1px solid #ddd; border-radius: 12px; background: white; box-shadow: 0 1px 4px rgba(0,0,0,.06); }
    img { display: block; width: 100%; height: auto; }
    figcaption { padding: 10px 12px; border-top: 1px solid #eee; font-size: 13px; color: #444; }
    li { margin: 8px 0; }
    .passed-text { color: #0a7f35; font-weight: 700; }
    .failed-text, .error { color: #b42318; font-weight: 700; }
    .skipped { color: #8a5a00; }
    code { background: #ededf0; padding: 2px 5px; border-radius: 5px; }
  </style>
</head>
<body>
  <main>
    <h1>fraimz</h1>
    <p class="muted">Frame-by-frame proof of the flow, as the end user experienced it.</p>
    <div class="meta">
      Run ID: <code>${escapeHtml(report.runId)}</code><br />
      Started: ${escapeHtml(report.startedAt)}<br />
      Finished: ${escapeHtml(report.finishedAt ?? "") }<br />
      CDP: <code>${escapeHtml(report.cdpUrl)}</code>
    </div>
    <div class="summary">
      <span>Passed: ${report.summary.passed}</span>
      <span>Failed: ${report.summary.failed}</span>
      <span>Skipped: ${report.summary.skipped}</span>
    </div>
    ${flowSections}
  </main>
</body>
</html>`;
}

function renderEvidence(evidence) {
  if (evidence.length === 0) return `<p class="muted">No structured evidence recorded for this step.</p>`;
  return `<div class="evidence">${evidence.map((item) => {
    if (item.type === "claim") {
      return `<div class="claim"><strong>${escapeHtml(item.name ?? "Claim")}</strong><br />${escapeHtml(item.claim ?? "")}</div>`;
    }
    if (item.type === "assertion") {
      const cls = item.status === "passed" ? "passed-text" : "failed-text";
      return `<div><span class="${cls}">${escapeHtml(item.status ?? "unknown")}</span> ${escapeHtml(item.assertion ?? "Assertion")}${item.actual ? `<br /><span class="muted">Actual: ${escapeHtml(item.actual)}</span>` : ""}</div>`;
    }
    if (item.type === "frame") {
      const validations = (item.validations ?? []).map((validation) => {
        const cls = validation.passed ? "passed-text" : "failed-text";
        return `<li><span class="${cls}">${validation.passed ? "PASS" : "FAIL"}</span> ${escapeHtml(validation.label)}${validation.detail ? ` <span class="muted">${escapeHtml(validation.detail)}</span>` : ""}</li>`;
      }).join("\n");
      return `<figure>
        <a href="${escapeHtml(item.file)}"><img src="${escapeHtml(item.file)}" alt="${escapeHtml(item.claim ?? item.name ?? item.file)}" /></a>
        <figcaption>
          <strong>${escapeHtml(item.name ?? item.file)}</strong>${item.claim ? `<br />Claim: ${escapeHtml(item.claim)}` : ""}
          ${item.url ? `<br /><span class="muted">URL: ${escapeHtml(item.url)}</span>` : ""}
          <ul class="validations">${validations}</ul>
        </figcaption>
      </figure>`;
    }
    return `<pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre>`;
  }).join("\n")}</div>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node evals/runner/run.mjs [--list | --all | --flow <id> ...] [--cdp-url <url>] [--out <dir>] [--stack den | --stack-down]");
    return;
  }

  if (args.stackDown) {
    await denStackDown({ log: (msg) => console.log(`▸ ${msg}`) });
    return;
  }

  if (args.stack === "den") {
    await ensureDenStack({
      log: (msg) => console.log(`▸ ${msg}`),
      cdpCandidates: args.cdpUrl ? [args.cdpUrl] : DEFAULT_CDP_CANDIDATES,
    });
  } else if (args.stack) {
    throw new Error(`Unknown stack: ${args.stack}. Supported: den`);
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

  if (report.summary.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
