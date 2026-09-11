import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { catalog, selectJourneys, unmetLaneNeeds } from './journey-catalog.mjs';

const changed = process.env.CHANGED_FILES ? JSON.parse(await readFile(process.env.CHANGED_FILES, 'utf8')) : [];
const critical = process.env.EVENT_NAME === 'workflow_run' || process.env.SUITE === 'critical';
const all = await catalog();
const selected = selectJourneys(all, { critical, only: process.env.ONLY_FILTER || '', changed: changed.map(file => file.replace('evals/specs/', '')) });
const eligible = selected.filter(entry => entry.placement !== 'manual');
// A journey the lane cannot satisfy would only ever skip. It is excluded from the matrix and
// reported as "skipped: lane cannot satisfy prerequisites" — a coverage gap, not a pass or a fail.
const automatic = [];
const excluded = [];
for (const entry of eligible) {
  const missing = unmetLaneNeeds(entry);
  if (missing.length === 0) automatic.push(entry);
  else excluded.push({ ...entry, reason: missing.join(', ') });
}
if (automatic.length === 0) throw new Error(`No automated journeys matched. Check the filter; this is not a passing run.${excluded.length > 0 ? ` ${excluded.length} matched journey(s) are skipped because this lane cannot satisfy their prerequisites: ${excluded.map(entry => entry.spec).join(', ')}.` : ''}`);
const plan = { suite: critical ? 'Critical user journeys' : 'Full regression', entries: automatic, manual: selected.filter(entry => entry.placement === 'manual'), excluded };
await mkdir('journey-plan', { recursive: true });
await writeFile('journey-plan/plan.json', JSON.stringify(plan, null, 2));
for (const placement of ['daytona', 'local']) {
  const entries = automatic.filter(entry => entry.placement === placement);
  await appendFile(process.env.GITHUB_OUTPUT, `${placement}=${JSON.stringify(entries)}\nhas_${placement}=${entries.length > 0}\n`);
}
await appendFile(process.env.GITHUB_OUTPUT, `suite=${plan.suite}\n`);
await appendFile(process.env.GITHUB_STEP_SUMMARY, `## ${plan.suite}\n\n${automatic.length} spec files selected. Each can contain multiple tests.\n\n${automatic.map(entry => `- ${entry.name}${entry.critical ? ' (critical)' : ''} — ${entry.placement}`).join('\n')}\n\n${excluded.length} journeys skipped (prerequisites unmet) — this lane cannot satisfy them, so they are not scheduled and not counted; the coverage gap stays visible here.\n${excluded.map(entry => `- ${entry.name} — needs: ${entry.reason}`).join('\n')}\n\n${plan.manual.length} additional specs require manual execution and are outside automatic coverage.\n${plan.manual.map(entry => `- ${entry.spec}`).join('\n')}\n`);
