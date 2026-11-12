import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Independent of premerge checks. Run manually: node --test .github/scripts/notify-alpha.test.mjs
// State is an incident ledger, not a regression detector: the SHA is the first
// *observed* failure, never a claim about the commit that introduced the bug.
// Recovery requires a successful push with both real build/package lanes. A
// failed-jobs-only rerun may lack that evidence and conservatively stays open.
// Bounds: 300 jobs, 100 state artifacts, 20 provenance lookups; fail closed on
// truncation rather than quietly resetting deduplication. Retention is 90 days.
// Slack and artifact upload cannot be atomic: a crash between them can duplicate
// a message. GitHub concurrency can replace pending observers during a burst.
export const WORKFLOW = 'Alpha Channels (macOS arm64 + Windows x64)';
const MAC = 'Build alpha (aarch64-apple-darwin)';
const PUBLISH_MAC = 'Publish alpha (aarch64-apple-darwin)';
const WINDOWS = 'Build + Publish alpha (x86_64-pc-windows-msvc)';
const failed = conclusion => ['failure', 'timed_out'].includes(conclusion);
const sequence = run => [run.run_number, run.run_attempt];
const compare = (a, b) => a[0] - b[0] || a[1] - b[1];
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const label = text => escape(text).replaceAll(/[\r\n]/g, ' ').slice(0, 220);
const runUrl = run => `${run.html_url}/attempts/${run.run_attempt}`;
const requiredSteps = new Map([
  [MAC, ['Build Electron alpha app', 'Package Electron alpha (macOS, signed + notarized)']],
  [WINDOWS, ['Build Electron alpha app', 'Package Electron alpha (Windows x64)']],
]);

export function trusted(run, repo) {
  return repo === 'different-ai/openwork' && run?.head_repository?.full_name === repo &&
    run.event === 'push' && run.head_branch === 'dev' && run.name === WORKFLOW &&
    run.status === 'completed' && Number.isSafeInteger(run.run_number) &&
    Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0 &&
    /^[a-f0-9]{40}$/.test(run.head_sha) &&
    run.html_url === `https://github.com/${repo}/actions/runs/${run.id}`;
}

export function fullBuildSucceeded(run, jobs) {
  return run.conclusion === 'success' && jobs.every(job => job.conclusion === 'success') &&
    jobs.some(job => job.name === PUBLISH_MAC && job.conclusion === 'success') &&
    [...requiredSteps].every(([name, steps]) => jobs.some(job => job.name === name &&
      job.conclusion === 'success' && steps.every(step => job.steps?.some(entry =>
        entry.name === step && entry.conclusion === 'success'))));
}

export function notification(previous, run, jobs, channel) {
  const state = structuredClone(previous?.channel === channel ? previous : {
    version: 1, channel, recovered: [0, 0], jobSequences: {}, failures: {},
  });
  const current = sequence(run);
  // A late older completion or rerun cannot reopen an incident after a newer
  // verified build. No-op/skip runs never establish this recovery watermark.
  if (compare(current, state.recovered) <= 0) return { state, message: null };
  const newFailures = [];
  for (const job of jobs) {
    if (!failed(job.conclusion) && job.conclusion !== 'success') continue;
    const jobKey = JSON.stringify(job.name);
    if (state.jobSequences[jobKey] && compare(current, state.jobSequences[jobKey]) <= 0) continue;
    state.jobSequences[jobKey] = current;
    if (!failed(job.conclusion)) continue;
    const steps = job.steps?.filter(step => failed(step.conclusion)) ?? [];
    for (const step of steps.length ? steps : [{ name: '(no failed step reported)' }]) {
      // Names, not numeric IDs, remain stable across pushes and reruns.
      const key = JSON.stringify([job.name, step.name]);
      if (state.failures[key]) continue;
      const entry = { job: job.name, step: step.name, sha: run.head_sha, url: runUrl(run), sequence: current };
      state.failures[key] = entry;
      newFailures.push(entry);
    }
  }
  let text;
  // A late green run must not clear failures (including another lane) that
  // have already been seen at a newer sequence.
  const newerEvidence = Object.values(state.jobSequences).some(value => compare(value, current) > 0);
  if (fullBuildSucceeded(run, jobs) && !newerEvidence) {
    const hadFailures = Object.keys(state.failures).length > 0;
    state.failures = {};
    state.recovered = current;
    if (hadFailures) text = `*Alpha pipeline recovered* — both build/package lanes passed.\n<${runUrl(run)}|View verified run> · SHA ${run.head_sha}`;
  } else if (newFailures.length) {
    const details = newFailures.slice(0, 15).map(entry =>
      `• Job: ${label(entry.job)}\n  Step: ${label(entry.step)}\n  First observed failed SHA: ${entry.sha}\n  <${entry.url}|First observed failed run>`).join('\n');
    text = `*Alpha pipeline — new failure signature${newFailures.length === 1 ? '' : 's'}*\n${details}${newFailures.length > 15 ? `\n…and ${newFailures.length - 15} more; see the run.` : ''}\nFirst observed failures, not a determination of the causal regression. Repeats stay quiet until a verified recovery.`;
  }
  return { state, message: text ? { text, unfurl_links: false, unfurl_media: false } : null };
}

export async function deliver(decision, { token, channel, request = fetch }) {
  if (!decision.message) return decision.state;
  if (!token || !channel) throw new Error('Set SLACK_BOT_TOKEN and SLACK_RELEASE_CHANNEL_ID; invite the bot to the existing release channel');
  const response = await request('https://slack.com/api/chat.postMessage', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, ...decision.message }), signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok || typeof result.ts !== 'string') throw new Error(`Slack delivery failed: ${result.error || response.status}`);
  return decision.state;
}

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
const api = path => JSON.parse(gh('api', path));

export async function loadJobs(loadPage) {
  const jobs = [];
  for (let page = 1; page <= 3; page++) {
    const result = await loadPage(page);
    if (result.total_count > 300) throw new Error('Alpha jobs exceed the 300-job safety bound');
    jobs.push(...result.jobs);
    if (jobs.length >= result.total_count) return jobs;
  }
  throw new Error('Incomplete alpha job evidence');
}

// Search the named artifacts directly, newest upload first, not by producer
// run_number: notifier executions themselves may complete out of creation order.
// Verify provenance before downloading: a PR can upload an identically named file.
export async function findStateArtifact(artifacts, self, currentId, loadRun) {
  let lookups = 0;
  for (const artifact of [...artifacts].sort((a, b) => b.id - a.id)) {
    if (artifact.expired || String(artifact.workflow_run?.id) === String(currentId)) continue;
    if (++lookups > 20) throw new Error('State provenance lookup bound exceeded');
    const owner = await loadRun(artifact.workflow_run.id);
    if (owner.workflow_id === self.workflow_id && owner.event === 'workflow_run' &&
        owner.head_repository?.full_name === self.head_repository?.full_name &&
        owner.conclusion === 'success' && owner.status === 'completed') return artifact;
  }
  if (artifacts.length >= 100) throw new Error('State artifact search truncated without a trusted snapshot');
  return undefined;
}

function validateState(state) {
  const validSequence = value => Array.isArray(value) && value.length === 2 && value.every(Number.isSafeInteger);
  if (state?.version !== 1 || !validSequence(state.recovered) || typeof state.channel !== 'string' ||
      !state.jobSequences || !state.failures ||
      !Object.values(state.jobSequences).every(validSequence) ||
      !Object.values(state.failures).every(entry => typeof entry.job === 'string' && typeof entry.step === 'string' &&
        typeof entry.sha === 'string' && typeof entry.url === 'string' && validSequence(entry.sequence))) {
    throw new Error('Invalid alpha alert state; refusing to reset deduplication');
  }
  return state;
}

async function main() {
  const { workflow_run: run } = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const repo = process.env.GITHUB_REPOSITORY;
  if (!trusted(run, repo)) throw new Error('Only trusted alpha dev push completions may notify');
  const self = api(`repos/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`);
  const name = `alpha-alert-state-${run.workflow_id}`;
  const artifactResult = api(`repos/${repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`);
  const artifact = await findStateArtifact(artifactResult.artifacts, self, process.env.GITHUB_RUN_ID,
    id => api(`repos/${repo}/actions/runs/${id}`));
  let previous;
  if (artifact) {
    gh('run', 'download', String(artifact.workflow_run.id), '--repo', repo, '--name', name, '--dir', 'previous-alpha-state');
    const raw = await readFile('previous-alpha-state/state.json', 'utf8');
    if (raw.length > 1_000_000) throw new Error('Alpha state exceeds safety bound');
    previous = validateState(JSON.parse(raw));
  }
  // Attempt-specific evidence cannot accidentally inspect a later rerun while
  // processing this event. Partial reruns do not claim full-lane recovery.
  const jobs = await loadJobs(page => api(`repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`));
  if (!jobs.length) throw new Error('No alpha job evidence returned');
  const channel = process.env.SLACK_RELEASE_CHANNEL_ID;
  if (!channel) throw new Error('SLACK_RELEASE_CHANNEL_ID must select the existing release channel');
  const decision = notification(previous, run, jobs, channel);
  const state = await deliver(decision, { token: process.env.SLACK_BOT_TOKEN, channel });
  await mkdir('alpha-alert-state', { recursive: true });
  await writeFile('alpha-alert-state/state.json', JSON.stringify(state));
  await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `## Alpha failure observer\n\n${decision.message ? 'Sent a new failure or verified recovery to the release channel.' : 'No new failure signature or verified recovery; Slack stayed quiet.'}\n\nFirst observed SHA is not a causal-regression claim. Skips and partial reruns cannot prove recovery. State retention: 90 days.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
