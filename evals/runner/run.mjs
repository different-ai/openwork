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
import { checkVoiceoverCoverage, loadVoiceoverParagraphs, scaffoldFlow } from "./voiceover.mjs";
import { postPrComment } from "./pr.mjs";

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
const FLOWS_DIR = process.env.OPENWORK_EVAL_FLOWS_DIR?.trim() || join(RUNNER_DIR, "..", "flows");
const DEFAULT_RESULTS_DIR = join(RUNNER_DIR, "..", "results");
const DEFAULT_CDP_CANDIDATES = ["http://127.0.0.1:9825", "http://127.0.0.1:9823"];

function parseArgs(argv) {
  const args = { flows: [], all: false, list: false, cdpUrl: null, out: null, stack: null, stackDown: false, scaffold: null, force: false, pr: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--flow") args.flows.push(argv[++index]);
    else if (value === "--all") args.all = true;
    else if (value === "--list") args.list = true;
    else if (value === "--cdp-url") args.cdpUrl = argv[++index];
    else if (value === "--out") args.out = argv[++index];
    else if (value === "--stack") args.stack = argv[++index];
    else if (value === "--stack-down") args.stackDown = true;
    else if (value === "scaffold") args.scaffold = argv[++index];
    else if (value === "--force") args.force = true;
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
    if (flow.kind !== undefined && flow.kind !== "user-facing" && flow.kind !== "internal") {
      throw new Error(`Flow file ${entry} has invalid kind ${JSON.stringify(flow.kind)}. Use "user-facing" (flow demo) or "internal" (internal demo, e.g. perf).`);
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
    kind: flow.kind ?? null,
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

  // Flows with `requiresApp: false` (e.g. DX/tooling demos) run without a CDP
  // connection: their frames are claims + assertions + recorded outputs.
  const requiresApp = flow.requiresApp !== false;
  let client = null;
  if (requiresApp) {
    const target = await pickAppTarget(cdpBaseUrl);
    client = await connect(debuggerUrlFor(cdpBaseUrl, target));
  }
  const ctx = new EvalContext({ client, outDir, flowId: flow.id, env, cdpBaseUrl });

  try {
    // Force light mode by default so screenshot evidence is readable. Flows
    // that are themselves testing theme/dark-mode behavior can opt out with
    // `preserveTheme: true` in the flow definition.
    if (requiresApp && !flow.preserveTheme) {
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
        if (client) await ctx.screenshot("failure").catch(() => undefined);
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
        if (client) await ctx.screenshot("failure").catch(() => undefined);
        break;
      }
    }

    // Voice-over drift check: when an approved script exists for this flow
    // (evals/voiceovers/<id>.md), every scripted paragraph must have been
    // narrated by the run, and the run must not narrate unapproved lines.
    if (result.status === "passed") {
      const paragraphs = await loadVoiceoverParagraphs(flow.id);
      if (paragraphs) {
        const recorded = new Set();
        for (const step of result.steps) {
          for (const evidence of step.evidence ?? []) {
            if (evidence.voiceover) recorded.add(evidence.voiceover);
          }
        }
        const coverage = checkVoiceoverCoverage(paragraphs, [...recorded]);
        const evidence = paragraphs.map((paragraph, index) => ({
          type: "assertion",
          status: coverage.missing.includes(paragraph) ? "failed" : "passed",
          assertion: `Script frame ${index + 1} narrated: ${JSON.stringify(paragraph.slice(0, 88))}`,
        }));
        for (const line of coverage.extra) {
          evidence.push({ type: "assertion", status: "failed", assertion: `Narration not in the approved script: ${JSON.stringify(line.slice(0, 88))}` });
        }
        result.steps.push({
          name: "Voice-over script coverage",
          status: coverage.ok ? "passed" : "failed",
          durationMs: 0,
          error: coverage.ok ? null : `Narration drifted from evals/voiceovers/${flow.id}.md (${coverage.missing.length} missing, ${coverage.extra.length} unapproved).`,
          evidence,
        });
        if (!coverage.ok) result.status = "failed";
      }
    }
  } finally {
    result.screenshots = ctx.screenshots;
    result.evidenceFrames = ctx.evidenceFrames;
    result.logs = ctx.logs;
    client?.close();
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
    if (flow.kind) lines.push(`Kind: ${flow.kind === "user-facing" ? "user-facing flow demo" : "internal demo"}`);
    if (flow.spec) lines.push(`Spec: ${flow.spec}`);
    if (flow.skipReason) lines.push(`Skipped: ${flow.skipReason}`);
    lines.push("");
    for (const step of flow.steps ?? []) {
      const stepIcon = step.status === "passed" ? "✅" : "❌";
      lines.push(`- ${stepIcon} ${step.name} (${step.durationMs}ms)${step.error ? ` — ${step.error}` : ""}`);
      for (const evidence of step.evidence ?? []) {
        if (evidence.type === "frame") {
          lines.push(`  - Frame: ${evidence.file} (${evidence.status})`);
          if (evidence.voiceover) lines.push(`    - Voiceover: ${evidence.voiceover}`);
        }
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

function flowKindBadge(kind) {
  if (kind === "user-facing") return `<span class="kind kind-user">User-facing flow demo</span>`;
  if (kind === "internal") return `<span class="kind kind-internal">Internal demo</span>`;
  return `<span class="kind kind-legacy">Legacy flow — no demo kind declared</span>`;
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
      <section data-flow="${escapeHtml(flow.id)}">
        <h2>${escapeHtml(flow.id)} - ${escapeHtml(flow.title)}</h2>
        <p>${flowKindBadge(flow.kind)} <button type="button" class="speak-all" data-flow-id="${escapeHtml(flow.id)}">▶ Play full voiceover</button></p>
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
    .voiceover { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-left: 4px solid #0e7490; background: #ecfeff; border-radius: 8px; font-style: italic; }
    .voiceover-missing { padding: 8px 12px; border-left: 4px solid #d97706; background: #fffbeb; border-radius: 8px; color: #92400e; font-size: 13px; }
    .speak, .speak-all { flex-shrink: 0; border: 1px solid #0e7490; border-radius: 999px; background: white; color: #0e7490; font-size: 12px; padding: 3px 10px; cursor: pointer; }
    .speak:hover, .speak-all:hover { background: #cffafe; }
    .kind { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }
    .kind-user { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
    .kind-internal { background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; }
    .kind-legacy { background: #fffbeb; color: #92400e; border: 1px solid #fde68a; }
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
    pre.output { margin: 0; padding: 12px; background: #16181d; color: #d6e2f0; font-size: 12.5px; line-height: 1.5; overflow-x: auto; border-radius: 0 0 12px 12px; }
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
  <script>
    (function () {
      if (!("speechSynthesis" in window)) return;
      var speak = function (texts) {
        window.speechSynthesis.cancel();
        texts.forEach(function (text) {
          var utterance = new SpeechSynthesisUtterance(text);
          utterance.rate = 1.05;
          window.speechSynthesis.speak(utterance);
        });
      };
      document.querySelectorAll(".voiceover .speak").forEach(function (button) {
        button.addEventListener("click", function () {
          var host = button.closest(".voiceover");
          if (host) speak([host.getAttribute("data-voiceover") || ""]);
        });
      });
      document.querySelectorAll(".speak-all").forEach(function (button) {
        button.addEventListener("click", function () {
          var section = button.closest("section");
          if (!section) return;
          var texts = Array.prototype.map.call(
            section.querySelectorAll(".voiceover[data-voiceover]"),
            function (node) { return node.getAttribute("data-voiceover"); }
          ).filter(Boolean);
          speak(texts);
        });
      });
    })();
  </script>
</body>
</html>`;
}

function renderEvidence(evidence) {
  if (evidence.length === 0) return `<p class="muted">No structured evidence recorded for this step.</p>`;
  return `<div class="evidence">${evidence.map((item) => {
    if (item.type === "claim") {
      // App-less frames (requiresApp: false) have no screenshot figure, so the
      // completed claim carries the narration instead.
      const voiceover = item.status === "passed" && item.voiceover
        ? `<div class="voiceover" data-voiceover="${escapeHtml(item.voiceover)}"><button type="button" class="speak" title="Play voiceover">🎙 Play</button><span>${escapeHtml(item.voiceover)}</span></div>`
        : "";
      return `<div class="claim"><strong>${escapeHtml(item.name ?? "Claim")}</strong><br />${escapeHtml(item.claim ?? "")}</div>${voiceover}`;
    }
    if (item.type === "output") {
      return `<figure><figcaption><strong>${escapeHtml(item.name ?? "Output")}</strong></figcaption><pre class="output">${escapeHtml(item.text ?? "")}</pre></figure>`;
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
      const voiceover = item.voiceover
        ? `<div class="voiceover" data-voiceover="${escapeHtml(item.voiceover)}"><button type="button" class="speak" title="Play voiceover">🎙 Play</button><span>${escapeHtml(item.voiceover)}</span></div>`
        : `<div class="voiceover-missing">No voiceover for this frame. Every fraimz frame should narrate what the user sees.</div>`;
      return `<figure>
        ${voiceover}
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
    console.log("Usage: node evals/runner/run.mjs [--list | --all | --flow <id> ... | scaffold <id> [--force]] [--cdp-url <url>] [--out <dir>] [--pr [number]] [--stack den | --stack-down]");
    return;
  }

  if (args.stackDown) {
    await denStackDown({ log: (msg) => console.log(`▸ ${msg}`) });
    return;
  }

  if (args.scaffold) {
    const { flowPath, frames } = await scaffoldFlow(args.scaffold, { flowsDir: FLOWS_DIR, force: args.force });
    console.log(`Scaffolded ${flowPath} — ${frames} frames from evals/voiceovers/${args.scaffold}.md.`);
    console.log("Fill in each frame's action/assert, then run: pnpm fraimz --flow " + args.scaffold);
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

  // App-less flows (requiresApp: false) don't need a CDP endpoint; only probe
  // for one when at least one selected flow drives the app.
  const needsApp = selected.some((flow) => flow.requiresApp !== false);
  const envCdp = process.env.OPENWORK_EVAL_CDP_URL?.trim();
  const cdpBaseUrl = args.cdpUrl
    ?? (envCdp || (needsApp ? await resolveCdpBaseUrl(DEFAULT_CDP_CANDIDATES) : null));

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(args.out ?? DEFAULT_RESULTS_DIR, runId);
  await mkdir(outDir, { recursive: true });

  const report = {
    runId,
    startedAt: new Date().toISOString(),
    cdpUrl: cdpBaseUrl ?? "(app-less run)",
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
