import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const statuses = new Set(['passed', 'failed', 'not tested']);
export function validateReport(report) {
  if (!report || !Array.isArray(report.entries) || report.entries.length === 0 || report.entries.length > 1000) throw new Error('Missing or invalid coverage report');
  const entries = report.entries.map(entry => {
    if (typeof entry.spec !== 'string' || typeof entry.name !== 'string' || !statuses.has(entry.status)) throw new Error('Invalid journey result');
    return { spec: entry.spec.slice(0, 200), name: entry.name.slice(0, 200), status: entry.status, critical: entry.critical === true };
  });
  if (new Set(entries.map(entry => entry.spec)).size !== entries.length) throw new Error('Duplicate journey results');
  return { entries, counts: Object.fromEntries([...statuses].map(status => [status, entries.filter(entry => entry.status === status).length])) };
}

export function notification(previous, run, report, teamId = '') {
  const sequence = [run.run_number, run.run_attempt];
  if (previous && (previous.sequence[0] > sequence[0] || (previous.sequence[0] === sequence[0] && previous.sequence[1] >= sequence[1]))) return { state: previous, message: null };
  const bad = report.entries.filter(entry => entry.status !== 'passed');
  const failures = bad.map(entry => `${entry.spec}:${entry.status}`).sort();
  const newFailures = failures.some(key => !previous?.failures.includes(key));
  const critical = report.entries.filter(entry => entry.critical);
  const state = { sequence, failures, thread: bad.length ? previous?.thread : undefined };
  if (bad.length === 0 && !previous?.failures.length) return { state, message: null };
  const title = run.name === 'Product journeys' ? 'Full regression — user journeys' : run.name === 'Build and core checks' ? 'Full regression — component checks' : 'Test reliability';
  const mention = bad.length && newFailures && /^[A-Z0-9]+$/.test(teamId) ? `<!subteam^${teamId}> ` : '';
  const summary = bad.length ? `${report.counts.passed} passed · ${report.counts.failed} failed · ${report.counts['not tested']} not tested` : 'Recovered — all selected checks passed';
  const criticalText = critical.length ? `\nCritical journeys: ${critical.every(entry => entry.status === 'passed') ? 'all passed' : '*ACTION NEEDED*'}` : '';
  const details = bad.slice(0, 30).map(entry => `• ${escape(entry.name)} — ${entry.status}`).join('\n');
  const text = `${mention}*${title}*\n${summary}${criticalText}${details ? `\n${details}` : ''}${bad.length > 30 ? `\n…and ${bad.length - 30} more; see the run.` : ''}\n<${run.html_url}|View run and evidence>`;
  return { state, message: { text, ...(previous?.thread ? { thread_ts: previous.thread } : {}), unfurl_links: false, unfurl_media: false } };
}

export async function deliver(previous, run, report, { token, channel, teamId, request = fetch }) {
  const decision = notification(previous?.channel === channel ? previous : undefined, run, report, teamId);
  decision.state = { ...decision.state, channel };
  if (!decision.message) return decision.state;
  const response = await request('https://slack.com/api/chat.postMessage', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, ...decision.message }), signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok || typeof result.ts !== 'string') throw new Error(`Slack delivery failed: ${result.error || response.status}`);
  if (decision.state.failures.length) decision.state.thread = decision.message.thread_ts || result.ts;
  return decision.state;
}

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const api = path => JSON.parse(gh('api', path));
async function main() {
  const { workflow_run: run } = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const repo = process.env.GITHUB_REPOSITORY;
  if (run.event !== 'schedule') throw new Error('Only scheduled runs may notify the team');
  const artifacts = api(`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`).artifacts;
  let report;
  if (run.name === 'Product journeys' && artifacts.some(artifact => artifact.name === 'journey-report' && !artifact.expired)) {
    gh('run', 'download', String(run.id), '--repo', repo, '--name', 'journey-report', '--dir', 'incoming-report');
    report = validateReport(JSON.parse(await readFile('incoming-report/journey-report.json', 'utf8')));
  } else {
    const pages = gh('api', '--paginate', '--slurp', `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
    const jobs = JSON.parse(pages).flatMap(page => page.jobs);
    const entries = jobs.filter(job => job.conclusion !== 'skipped').map(job => ({
      spec: job.name, name: job.name, critical: false,
      status: job.conclusion === 'success' ? 'passed' : job.conclusion === 'failure' ? 'failed' : 'not tested',
    }));
    if (!entries.length || run.name === 'Product journeys') entries.push({ spec: 'missing-coverage', name: 'Journey report unavailable — coverage could not be verified', critical: false, status: 'not tested' });
    report = validateReport({ entries });
  }
  // Missing reports, upload failures and aggregate failures cannot send a recovery.
  if (run.conclusion !== 'success' && report.entries.every(entry => entry.status === 'passed')) {
    report = validateReport({ entries: [...report.entries, { spec: 'workflow-incomplete', name: 'Workflow did not complete successfully', critical: false, status: 'not tested' }] });
  }
  const stateName = `test-alert-state-${run.workflow_id}`;
  let previous;
  const runs = api(`repos/${repo}/actions/workflows/e2e-test-failure-alerts.yml/runs?status=success&per_page=100`).workflow_runs;
  for (const candidate of runs) {
    if (String(candidate.id) === process.env.GITHUB_RUN_ID) continue;
    const available = api(`repos/${repo}/actions/runs/${candidate.id}/artifacts?per_page=100`).artifacts;
    if (!available.some(artifact => artifact.name === stateName && !artifact.expired)) continue;
    gh('run', 'download', String(candidate.id), '--repo', repo, '--name', stateName, '--dir', 'previous-state');
    previous = JSON.parse(await readFile('previous-state/state.json', 'utf8'));
    break;
  }
  await mkdir('alert-state', { recursive: true });
  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_TEST_ALERT_CHANNEL_ID) {
    // Do not mark undelivered alerts as sent. Keep last delivered state intact.
    if (previous) await writeFile('alert-state/state.json', JSON.stringify(previous));
    await appendFile(process.env.GITHUB_STEP_SUMMARY, '## Slack setup required\n\nSet the SLACK_BOT_TOKEN secret and SLACK_TEST_ALERT_CHANNEL_ID variable, and invite the bot to that channel. No Slack message was sent.\n');
    throw new Error('Slack notification credentials are not configured');
  }
  const state = await deliver(previous, run, report, { token: process.env.SLACK_BOT_TOKEN, channel: process.env.SLACK_TEST_ALERT_CHANNEL_ID, teamId: process.env.SLACK_TEST_ALERT_TEAM_ID });
  await writeFile('alert-state/state.json', JSON.stringify(state));
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Team notification\n\n${report.counts.passed} passed · ${report.counts.failed} failed · ${report.counts['not tested']} not tested. Healthy runs stay quiet; repeated failures reply in the existing incident thread.\n`);
  await rm('incoming-report', { recursive: true, force: true });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
