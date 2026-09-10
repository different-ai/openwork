import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { catalog, selectJourneys, unmetLaneNeeds } from './journey-catalog.mjs';

const changed = process.env.CHANGED_FILES ? JSON.parse(await readFile(process.env.CHANGED_FILES, 'utf8')) : [];
const critical = process.env.EVENT_NAME === 'workflow_run' || process.env.SUITE === 'critical';
const all = await catalog();
const selected = selectJourneys(all, { critical, only: process.env.ONLY_FILTER || '', changed: changed.map(file => file.replace('evals/specs/', '')) });
const eligible = selected.filter(entry => entry.placement !== 'manual');
// A journey the lane cannot satisfy would only ever skip; report it as not applicable instead of scheduling a red job.
const automatic = [];
const notApplicable = [];
for (const entry of eligible) {
  const missing = unmetLaneNeeds(entry);
  if (missing.length === 0) automatic.push(entry);
  else notApplicable.push({ ...entry, reason: missing.join(', ') });
}
if (automatic.length === 0) throw new Error(`No automated journeys matched. Check the filter; this is not a passing run.${notApplicable.length > 0 ? ` ${notApplicable.length} matched journey(s) are not applicable in this lane: ${notApplicable.map(entry => entry.spec).join(', ')}.` : ''}`);
const plan = { suite: critical ? 'Critical user journeys' : 'Full regression', entries: automatic, manual: selected.filter(entry => entry.placement === 'manual'), notApplicable };
await mkdir('journey-plan', { recursive: true });
await writeFile('journey-plan/plan.json', JSON.stringify(plan, null, 2));
for (const placement of ['daytona', 'local']) {
  const entries = automatic.filter(entry => entry.placement === placement);
  await appendFile(process.env.GITHUB_OUTPUT, `${placement}=${JSON.stringify(entries)}\nhas_${placement}=${entries.length > 0}\n`);
}
await appendFile(process.env.GITHUB_OUTPUT, `suite=${plan.suite}\n`);
await appendFile(process.env.GITHUB_STEP_SUMMARY, `## ${plan.suite}\n\n${automatic.length} spec files selected. Each can contain multiple tests.\n\n${automatic.map(entry => `- ${entry.name}${entry.critical ? ' (critical)' : ''} — ${entry.placement}`).join('\n')}\n\n${notApplicable.length} selected specs are not applicable in this lane and are excluded from the verdict.\n${notApplicable.map(entry => `- ${entry.name} — needs: ${entry.reason}`).join('\n')}\n\n${plan.manual.length} additional specs require manual execution and are outside automatic coverage.\n${plan.manual.map(entry => `- ${entry.spec}`).join('\n')}\n`);
