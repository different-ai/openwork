import { readdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function classify(summary, execution, vision, expectedSpec) {
  if (expectedSpec && !summary?.files?.includes(expectedSpec)) return 'not tested';
  if (!summary || summary.command !== 'evals:e2e' || !['passed', 'failed', 'skipped'].every(key => Number.isInteger(summary[key]) && summary[key] >= 0)) return 'not tested';
  if (summary.failed > 0 || vision === 'failure') return 'failed';
  if (summary.skipped > 0 || summary.passed === 0 || execution !== 'success' || vision !== 'success' || summary.verdict !== 'passed') return 'not tested';
  return 'passed';
}

export function aggregate(plan, results) {
  const entries = plan.entries.map(entry => {
    const matching = results.filter(result => result.spec === entry.spec);
    const result = matching.length === 1 ? matching[0] : null;
    return { ...entry, status: ['passed', 'failed', 'not tested'].includes(result?.status) ? result.status : 'not tested' };
  });
  const counts = Object.fromEntries(['passed', 'failed', 'not tested'].map(status => [status, entries.filter(entry => entry.status === status).length]));
  return { suite: plan.suite, entries, counts, manual: plan.manual, ok: counts.failed === 0 && counts['not tested'] === 0 && entries.length > 0 };
}

export function markdown(report) {
  const critical = report.entries.filter(entry => entry.critical);
  return `## ${report.suite} — ${report.ok ? 'passed' : 'action needed'}\n\n${report.counts.passed} passed · ${report.counts.failed} failed · ${report.counts['not tested']} not tested (spec files)\n\nCritical journeys: ${critical.length === 0 ? 'not selected' : critical.every(entry => entry.status === 'passed') ? 'all passed' : 'action needed'}\n\n| Journey | Result |\n|---|---|\n${report.entries.map(entry => `| ${entry.name}${entry.critical ? ' **(critical)**' : ''} | ${entry.status} |`).join('\n')}\n\n${report.manual.length} manual-only specs are outside automatic coverage. See the plan for their names.\n\nEvidence and logs are attached to this run. “Not tested” includes skipped tests, setup failures, missing results, and incomplete evidence.\n`;
}

async function main() {
  if (process.argv[2] === 'record') {
    let summary;
    try {
      const lines = (await readFile(process.env.JOURNEY_LOG, 'utf8')).split('\n');
      for (const line of lines) {
        try { const value = JSON.parse(line); if (value.command === 'evals:e2e') summary = value; } catch { /* non-summary log line */ }
      }
    } catch { /* setup never reached the test command */ }
    const status = classify(summary, process.env.EXECUTION, process.env.VISION, process.env.SPEC_SLUG);
    await writeFile('journey-result.json', JSON.stringify({ spec: process.env.SPEC_SLUG, status, summary }, null, 2));
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `\nJourney result: **${status}**\n`);
  } else {
    const plan = JSON.parse(await readFile('journey-plan/plan.json', 'utf8'));
    const results = [];
    async function visit(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.name === 'journey-result.json') results.push(JSON.parse(await readFile(path, 'utf8')));
      }
    }
    await visit('journey-results');
    const report = aggregate(plan, results);
    await writeFile('journey-report.json', JSON.stringify(report, null, 2));
    await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown(report));
    if (!report.ok) process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
