import type { TestArtifact, TestRunRecord } from "./schema.ts";
import type { TestArtifactIndexEntry } from "./scan.ts";

export interface RenderPrOptions {
  title?: string;
  reproCommand?: string;
  notice?: string;
  sourcePath?: string;
}

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function artifactBadge(entry: TestArtifactIndexEntry): { label: string; className: string; summary: string } {
  if (entry.kind === "legacy-artifacts") {
    return {
      label: "LEGACY",
      className: "legacy",
      summary: `${entry.pngFiles.length} loose screenshot${entry.pngFiles.length === 1 ? "" : "s"}`,
    };
  }
  const summary = entry.testRun.summary;
  if (entry.testRun.outcome === "failed") {
    return { label: "FAILED", className: "failed", summary: entry.testRun.failure ?? "Test body failed" };
  }
  if (entry.testRun.outcome === "skipped") {
    return { label: "SKIPPED", className: "pending", summary: entry.testRun.failure ?? "Test skipped" };
  }
  if (summary.failedArtifacts > 0 || summary.failedExpectations > 0) {
    return {
      label: "FAILED",
      className: "failed",
      summary: `${summary.passedArtifacts}/${summary.totalArtifacts} artifacts passed · ${summary.failedArtifacts} failed`,
    };
  }
  if (summary.pendingArtifacts > 0 || summary.pendingJudgments > 0) {
    return {
      label: "PENDING",
      className: "pending",
      summary: `${summary.pendingArtifacts}/${summary.totalArtifacts} artifacts pending · ${summary.pendingJudgments} expectations pending`,
    };
  }
  if (summary.ok) {
    return {
      label: "PASSED",
      className: "passed",
      summary: `${summary.passedArtifacts}/${summary.totalArtifacts} artifacts passed`,
    };
  }
  if (entry.testRun.outcome === "passed") {
    return { label: "PASSED", className: "passed", summary: "Provenance trace passed" };
  }
  return {
    label: "UNVALIDATED",
    className: "unvalidated",
    summary: `${summary.unvalidatedArtifacts}/${summary.totalArtifacts} artifacts unvalidated`,
  };
}

interface TraceGroup {
  label: string;
  entries: { detail: string; count: number }[];
}

function renderedTrace(testRun: TestRunRecord): TestRunRecord["trace"] {
  return testRun.trace.filter((entry) => entry.verb !== "tmpPath");
}

function traceGroups(testRun: TestRunRecord): TraceGroup[] {
  const groups: TraceGroup[] = [];
  for (const entry of [...renderedTrace(testRun)].sort((left, right) => left.seq - right.seq)) {
    if (entry.channel === "step") continue;
    const label = entry.stage === "world" ? "world" : entry.channel;
    let group = groups.at(-1);
    if (group?.label !== label) {
      group = { label, entries: [] };
      groups.push(group);
    }
    const detail = `${entry.ok ? "" : "❌ "}${entry.detail}`;
    const previous = group.entries.at(-1);
    if (previous?.detail === detail) previous.count += 1;
    else group.entries.push({ detail, count: 1 });
  }
  return groups;
}

function stepLine(testRun: TestRunRecord): string | null {
  if (testRun.steps.length === 0) return null;
  return testRun.steps.map((step, index) => {
    const icon = step.ok === true ? "✅" : step.ok === false ? "❌" : "⏭";
    const duration = step.ms === undefined ? "" : ` (${(step.ms / 1_000).toFixed(1)}s)`;
    return `${index + 1} ${icon} ${step.name}${duration}`;
  }).join(" · ");
}

function verdictLine(testRun: TestRunRecord): string {
  const trace = renderedTrace(testRun);
  const observations = trace.filter((entry) => (
    (entry.channel === "user" && (entry.verb === "see" || entry.verb === "notSee" || entry.verb === "screenshot"))
    || entry.channel === "vision"
  ));
  const observationCounts = new Map<string, number>();
  for (const entry of observations) observationCounts.set(entry.verb, (observationCounts.get(entry.verb) ?? 0) + 1);
  const observationDetail = [...observationCounts.entries()].map(([verb, count]) => `${verb} ×${count}`).join(", ");
  const probes = trace.filter((entry) => entry.channel === "probe" || entry.channel === "probe:raw").length;
  const passedSteps = testRun.steps.filter((step) => step.ok === true).length;
  return `${testRun.outcome} · ${observations.length} user observations${observationDetail ? ` (${observationDetail})` : ""} · ${probes} probes · steps ${passedSteps}/${testRun.steps.length}`;
}

function traceMarkdown(testRun: TestRunRecord): string[] {
  const lines = traceGroups(testRun).map((group) => (
    `**[${group.label}]** ${group.entries.map((entry) => `${entry.detail}${entry.count > 1 ? ` ×${entry.count}` : ""}`).join(" · ")}`
  ));
  const steps = stepLine(testRun);
  if (steps) lines.push(`**steps** ${steps}`);
  lines.push(`**verdict** ${verdictLine(testRun)}`);
  return lines;
}

function traceHtml(testRun: TestRunRecord): string {
  const lines = traceGroups(testRun).map((group) => (
    `<div><strong>[${html(group.label)}]</strong> ${group.entries.map((entry) => `${html(entry.detail)}${entry.count > 1 ? ` ×${entry.count}` : ""}`).join(" · ")}</div>`
  ));
  const steps = stepLine(testRun);
  if (steps) lines.push(`<div><strong>steps</strong> ${html(steps)}</div>`);
  lines.push(`<div><strong>verdict</strong> ${html(verdictLine(testRun))}</div>`);
  return `<div class="trace">${lines.join("")}</div>`;
}

export function renderArtifactIndexHtml(entries: TestArtifactIndexEntry[]): string {
  const ordered = [...entries].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const cards = ordered.map((entry) => {
    const badge = artifactBadge(entry);
    const caption = entry.kind === "test-run" ? entry.testRun.artifacts[0]?.caption : undefined;
    const thumbnail = entry.thumbnailHref
      ? `<img src="${html(entry.thumbnailHref)}" alt="${html(caption ?? entry.name)}">`
      : `<div class="empty">No screenshot recorded</div>`;
    const provenance = entry.kind === "test-run" ? traceHtml(entry.testRun) : "";
    return `<article class="card ${badge.className}">
      <a class="thumb" href="${html(entry.href)}">${thumbnail}</a>
      <div class="copy">
        <div class="topline"><span class="badge">${badge.label}</span><time datetime="${html(entry.createdAt)}">${html(entry.createdAt)}</time></div>
        <h2><a href="${html(entry.href)}">${html(entry.name)}</a></h2>
        ${caption ? `<p class="caption">${html(caption)}</p>` : ""}
         <p class="summary">${html(badge.summary)}</p>
         ${provenance}
      </div>
    </article>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenWork test artifacts</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 20px;background:#f6f7f9;color:#17191d}header,.card{background:white;border:1px solid #dfe2e8;border-radius:12px;padding:20px;margin:0 0 24px}header h1{margin:0 0 6px}.muted,time,.summary{color:#636c76}.card{display:grid;grid-template-columns:minmax(220px,40%) 1fr;gap:20px}.card.passed{border-left:6px solid #238636}.card.failed{border-left:6px solid #cf222e}.card.pending,.card.unvalidated{border-left:6px solid #9a6700}.card.legacy{border-left:6px solid #656d76}.thumb img,.empty{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;border:1px solid #dfe2e8;border-radius:8px;background:#f6f7f9}.empty{display:grid;place-items:center;color:#636c76}.topline{display:flex;align-items:center;gap:10px}.badge{font-size:12px;font-weight:700}.passed .badge{color:#1a7f37}.failed .badge{color:#cf222e}.pending .badge,.unvalidated .badge{color:#9a6700}.legacy .badge{color:#656d76}h2{margin:12px 0 6px}a{color:inherit}.caption{font-weight:600}.trace{font-size:13px}.trace div{margin:4px 0}.trace strong{display:inline-block;min-width:65px}@media(max-width:700px){.card{grid-template-columns:1fr}}
</style></head><body><header><h1>Test artifacts</h1><p class="muted">Test evidence captured as the user experienced it, newest first.</p></header>${cards || '<p class="muted">No test artifacts found.</p>'}</body></html>\n`;
}

function summaryLine(testRun: TestRunRecord): string {
  const summary = testRun.summary;
  const failed = testRun.outcome === "failed" || summary.failedArtifacts > 0 || summary.failedExpectations > 0;
  const pending = summary.pendingArtifacts > 0 || summary.pendingJudgments > 0;
  const icon = failed ? "❌" : testRun.outcome === "skipped" || pending ? "⏳" : testRun.outcome === "passed" || summary.ok ? "✅" : "⚪";
  return `${icon} **${artifactVerdict(testRun)}** · ${summary.passedExpectations} expectations passed · ${summary.failedExpectations} failed · ${summary.pendingJudgments} pending`;
}

function outcomeHeading(testRun: TestRunRecord): string {
  if (testRun.outcome === "passed") return "✅ passed";
  if (testRun.outcome === "failed") return "❌ failed";
  if (testRun.outcome === "skipped") return "⏭ skipped";
  return artifactVerdict(testRun);
}

function renderArtifact(artifact: TestArtifact, sequence: number, imageUrl: string | undefined): string {
  const assertion = artifact.fileName.length === 0;
  const pending = artifact.judgments.some((judgment) => judgment.state === "pending");
  const marker = pending ? "⏳ PENDING" : assertion ? (artifact.ok === false ? "❌ FAIL ASSERTION" : "ℹ️ ASSERTION") : artifact.ok === false ? "❌ FAIL" : artifact.ok === true ? "✅ PASS" : "⚪ UNVALIDATED";
  const lines = [`### ${marker} — ${sequence}. ${html(artifact.caption)}`, ""];
  if (assertion && artifact.description) lines.push(html(artifact.description), "");
  if (artifact.judgments.length === 0) {
    lines.push("- ⚪ **UNVALIDATED** — no visual expectations recorded.");
  } else {
    for (const judgment of artifact.judgments) {
      const judgmentMarker = judgment.state === "passed" ? "✅ **PASS**" : judgment.state === "failed" ? "❌ **FAIL**" : "⏳ **PENDING**";
      lines.push(`- ${judgmentMarker} ${html(judgment.expectation)} — ${html(judgment.reasoning)}`);
    }
  }
  if (imageUrl) {
    lines.push("", `![${artifact.caption}](${imageUrl})`);
  }
  return lines.join("\n");
}

function artifactVerdict(testRun: TestRunRecord): string {
  const screenshots = testRun.artifacts.filter((artifact) => artifact.fileName.length > 0);
  if (screenshots.length === 0 && testRun.outcome !== "unknown") return testRun.outcome;
  const passed = screenshots.filter((artifact) => artifact.ok === true).length;
  const pending = screenshots.filter((artifact) => artifact.judgments.some((judgment) => judgment.state === "pending")).length;
  const assertions = testRun.artifacts.length - screenshots.length;
  return `${passed}/${screenshots.length} screenshots passed${pending > 0 ? ` · ${pending} pending` : ""}${assertions > 0 ? ` · ${assertions} assertion${assertions === 1 ? "" : "s"}` : ""}`;
}

export function renderPrMarkdown(
  testRun: TestRunRecord,
  urls: Record<string, string>,
  opts: RenderPrOptions = {},
): string {
  const title = opts.title ?? `Test evidence — ${testRun.name}`;
  const lines = [
    "<!-- test-evidence -->",
    `## ${html(title)} — ${outcomeHeading(testRun)}`,
    "",
    summaryLine(testRun),
  ];
  if (opts.notice) lines.push("", `> ${opts.notice}`);
  lines.push("", ...traceMarkdown(testRun));
  for (const [index, artifact] of testRun.artifacts.entries()) {
    lines.push("", renderArtifact(artifact, index + 1, urls[artifact.fileName]));
  }
  const source = opts.sourcePath ?? `evals/results/test-runs/${testRun.dir.split(/[\\/]/).at(-1) ?? testRun.name}/test-run.json`;
  lines.push(
    "",
    "---",
    `_Test run created ${html(testRun.createdAt)} · Source: \`${html(source)}\`${opts.reproCommand ? ` · Repro: \`${html(opts.reproCommand)}\`` : ""}_`,
    "<!-- /test-evidence -->",
  );
  return lines.join("\n");
}
