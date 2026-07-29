import type { EvalReport } from "../flow.ts";

function renderSoakTable(report: EvalReport): string[] {
  if (!report.soak?.length) return [];
  const lines = [
    "## Soak summary",
    "",
    "| Flow | Repeat | Passed | Failed | Skipped | Captured iterations | Status |",
    "| --- | ---: | ---: | ---: | ---: | --- | --- |",
  ];
  for (const soak of report.soak) {
    lines.push(`| ${soak.flowId} | ${soak.repeat} | ${soak.passed} | ${soak.failed} | ${soak.skipped} | ${soak.capturedIterations.join(", ") || "none"} | ${soak.status} |`);
  }
  lines.push("");
  return lines;
}

export function renderMarkdown(report: EvalReport): string {
  const lines = [
    `# Eval run ${report.runId}`,
    "",
    `- Started: ${report.startedAt}`,
    `- Mode: ${report.mode}`,
    `- CDP: ${report.cdpUrl}`,
    `- Result: ${report.summary.failed > 0 ? "FAILED" : "PASSED"} (${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped)`,
    `- fraimz: fraimz.html`,
    "",
  ];
  lines.push(...renderSoakTable(report));
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
