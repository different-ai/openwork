import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { catalog, selectJourneys, unmetLaneNeeds } from '../../evals/scripts/journey-catalog.mjs';
import { CHECK, POLICY, digest, upstreamIdentity, validateRun, validateReceipt, reconcile, summaryText } from './required-verification.mjs';

function command(program, args, input) {
  const result = spawnSync(program, args, { encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024, timeout: 90_000 });
  if (result.status !== 0 || result.error) throw new Error(`${program} operation failed`);
  return result.stdout;
}
const api = (path, body, method) => JSON.parse(command('gh', ['api', path, ...(body ? ['--method', method ?? 'POST', '--input', '-'] : [])], body ? JSON.stringify(body) : undefined));
async function workflows(repo) {
  const upstream = api(`repos/${repo}/actions/workflows/warden.yml`);
  const producer = api(`repos/${repo}/actions/workflows/daytona-e2e.yml`);
  if (upstream.path !== '.github/workflows/warden.yml' || producer.path !== '.github/workflows/daytona-e2e.yml') throw new Error('Workflow path mismatch');
  return { upstream, producer };
}
function pages(path, key) {
  const values = [];
  for (let page = 1; page <= 20; page++) {
    const data = api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const items = key ? data[key] : data;
    if (!Array.isArray(items)) throw new Error('Invalid API listing');
    values.push(...items);
    if (items.length < 100) return values;
  }
  throw new Error('API listing exceeds bound');
}
async function download(repo, runId, name, directory) {
  command('gh', ['run', 'download', String(runId), '--repo', repo, '--name', name, '--dir', directory]);
}

function currentArtifact(artifacts, name, run) {
  const matches = artifacts.filter(artifact => artifact.name === name);
  if (matches.length !== 1 || matches[0].expired ||
      !Number.isFinite(Date.parse(run.run_started_at)) || !Number.isFinite(Date.parse(matches[0].created_at)) ||
      Date.parse(matches[0].created_at) < Date.parse(run.run_started_at))
    throw new Error('Artifact is missing, duplicated, expired or from an earlier attempt');
  return matches[0];
}

function latestCheck(repo, sha) {
  return pages(`repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(CHECK)}&filter=all`, 'check_runs')
    .filter(check => check.app?.slug === 'github-actions' && /^required-v1:\d+:\d+$/.test(check.external_id ?? ''))
    .sort((a, b) => b.id - a.id)[0];
}

export async function optionalPublication(publish) {
  try { await publish(); } catch { console.warn('Required status comment unavailable; verification is unchanged.'); }
}

async function comment(receipt, summary, url) {
  const current = api(`repos/${receipt.repo}/pulls/${receipt.pr}`);
  if (current.head?.sha !== receipt.sha) return;
  if (latestCheck(receipt.repo, receipt.sha)?.external_id !== `required-v1:${receipt.producer.id}:${receipt.producer.attempt}`) return;
  const marker = '<!-- required-verification -->';
  const body = `${marker}\n${summaryText(summary, url)}\n\nCommit \`${receipt.sha}\`\n\nScope: critical and changed spec files; excluded and manual dispositions are not passing coverage.`;
  const existing = pages(`repos/${receipt.repo}/issues/${receipt.pr}/comments`)
    .find(value => value.user?.login === 'github-actions[bot]' && value.body?.startsWith(marker));
  if (existing) api(`repos/${receipt.repo}/issues/comments/${existing.id}`, { body }, 'PATCH');
  else api(`repos/${receipt.repo}/issues/${receipt.pr}/comments`, { body });
}

// Exported for the selected-evidence publisher too: a chained PR array is never authority.
export async function readBinding(repo, runId) {
  const known = await workflows(repo);
  const producer = api(`repos/${repo}/actions/runs/${runId}`);
  validateRun(producer, repo, known.producer, producer.run_attempt);
  const directory = await mkdtemp(join(tmpdir(), 'required-binding-'));
  try {
    currentArtifact(pages(`repos/${repo}/actions/runs/${producer.id}/artifacts`, 'artifacts'), `required-verification-${producer.run_attempt}`, producer);
    await download(repo, producer.id, `required-verification-${producer.run_attempt}`, directory);
    const { receipt, checkId } = JSON.parse(await readFile(join(directory, 'required-verification.json'), 'utf8'));
    if (receipt?.repo !== repo || producer.id !== Number(runId) ||
        ![checkId, receipt.pr, receipt.upstream?.id, receipt.upstream?.attempt, receipt.producer?.id, receipt.producer?.attempt]
          .every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Binding repository or run mismatch');
    const check = api(`repos/${repo}/check-runs/${checkId}`);
    const upstream = api(`repos/${repo}/actions/runs/${receipt.upstream.id}`);
    const current = api(`repos/${repo}/pulls/${receipt.pr}`);
    validateReceipt(receipt, check, producer, upstream, current, known);
    const jobs = pages(`repos/${repo}/actions/runs/${producer.id}/attempts/${producer.run_attempt}/jobs`, 'jobs');
    const authorization = jobs.filter(job => job.name === 'Required verification authorization');
    if (authorization.length !== 1 || authorization[0].conclusion !== 'success') throw new Error('Trusted authorization job did not complete');
    return { receipt, check, producer, upstream, current, known, jobs };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function requiredStatus(repo, pr, sha) {
  const fallback = { state: 'incomplete', missing: ['No authenticated current-head required plan'], failed: [] };
  try {
    const check = latestCheck(repo, sha);
    if (!check) return fallback;
    const runId = Number(check.external_id.split(':')[1]);
    const bound = await readBinding(repo, runId);
    if (bound.receipt.pr !== pr || bound.receipt.sha !== sha || bound.check.id !== check.id) return fallback;
    const state = check.status !== 'completed'
      ? bound.jobs.some(job => job.name.startsWith('Journey — ') && job.status === 'in_progress') ? 'running' : 'waiting'
      : check.conclusion === 'success' ? 'passed' : check.output?.title === 'Required verification: failed' ? 'failed' : 'incomplete';
    return { state, missing: state === 'passed' ? [] : ['Required specs are not all verified'], failed: [], url: bound.producer.html_url };
  } catch { return fallback; }
}

export async function authorize(event, repo) {
  const known = await workflows(repo);
  const producer = api(`repos/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`);
  validateRun(producer, repo, known.producer, Number(process.env.GITHUB_RUN_ATTEMPT));
  const upstream = api(`repos/${repo}/actions/runs/${event.workflow_run.id}`);
  if (upstream.run_attempt !== event.workflow_run.run_attempt || producer.event !== 'workflow_run') throw new Error('Event attempt mismatch');
  const candidates = (upstream.pull_requests ?? []).filter(pr => pr.base?.repo?.id === upstream.repository?.id);
  if (candidates.length !== 1) throw new Error('Cannot resolve upstream PR safely');
  const current = api(`repos/${repo}/pulls/${candidates[0].number}`);
  const identity = upstreamIdentity(upstream, repo, known.upstream, current);
  // Create pending before planning or environment approval. Any later failure stays non-passing.
  const check = api(`repos/${repo}/check-runs`, { name: CHECK, head_sha: identity.sha, status: 'in_progress',
    external_id: `required-v1:${producer.id}:${producer.run_attempt}`, details_url: producer.html_url,
    output: { title: 'Required verification: waiting', summary: 'Required plan authorization is pending; selected evidence is separate.' } });
  const directory = await mkdtemp(join(tmpdir(), 'required-plan-'));
  try {
    const files = pages(`repos/${repo}/pulls/${identity.pr}/files`);
    if (files.some(file => /^(evals\/scripts\/|\.github\/|warden\.toml$|\.warden\/|\.agents\/skills\/|\.claude\/skills\/)/.test(file.filename)))
      throw new Error('Trusted verification machinery changed; required verification is blocked');
    currentArtifact(pages(`repos/${repo}/actions/runs/${upstream.id}/artifacts`, 'artifacts'), 'warden-summary', upstream);
    await download(repo, upstream.id, 'warden-summary', directory);
    const warden = JSON.parse(await readFile(join(directory, 'warden-summary.json'), 'utf8'));
    if (warden.head_sha !== identity.sha || (warden.blocking_count ?? warden.findings_count) !== 0) throw new Error('Warden clearance missing');
    // Read PR source as data only. Never run its planner, imports, install hooks or helpers with checks:write.
    command('git', ['fetch', '--no-tags', 'origin', identity.sha]);
    const names = command('git', ['ls-tree', '-z', '--name-only', `${identity.sha}:evals/specs`]).split('\0').filter(name => name.endsWith('.e2e.test.ts'));
    if (names.some(name => !/^[a-zA-Z0-9_.-]+\.e2e\.test\.ts$/.test(name))) throw new Error('Unresolved spec filename; required plan is incomplete');
    for (const name of names)
      await writeFile(join(directory, name), command('git', ['show', `${identity.sha}:evals/specs/${name}`]));
    const selected = selectJourneys(await catalog(pathToFileURL(`${directory}/`)), { critical: true,
      changed: files.filter(file => file.status !== 'removed').map(file => file.filename.replace(/^evals\/specs\//, '')) });
    const manual = selected.filter(entry => entry.placement === 'manual');
    const eligible = selected.filter(entry => entry.placement !== 'manual');
    const excluded = eligible.filter(entry => unmetLaneNeeds(entry).length).map(entry => ({ ...entry, reason: unmetLaneNeeds(entry).join(', ') }));
    const plan = { entries: eligible.filter(entry => !unmetLaneNeeds(entry).length), manual, excluded, unresolved: [] };
    const receipt = { version: 1, policy: POLICY, repo, ...identity, upstream: { id: upstream.id, attempt: upstream.run_attempt },
      producer: { id: producer.id, attempt: producer.run_attempt }, plan };
    const latest = api(`repos/${repo}/pulls/${identity.pr}`);
    upstreamIdentity(upstream, repo, known.upstream, latest);
    api(`repos/${repo}/check-runs/${check.id}`, { output: { title: 'Required verification: waiting',
      summary: summaryText({ state: 'waiting', missing: plan.entries.map(entry => entry.spec), failed: [] }, producer.html_url),
      text: `Receipt SHA256: ${digest(receipt)}` } }, 'PATCH');
    await writeFile('required-verification.json', JSON.stringify({ checkId: check.id, receipt }));
    await appendFile(process.env.GITHUB_OUTPUT, `authorized=true\npr=${identity.pr}\nsha=${identity.sha}\nbase=${current.base.sha}\n`);
    await optionalPublication(() => comment(receipt, { state: 'waiting', missing: plan.entries.map(entry => entry.spec), failed: [] }, producer.html_url));
  } catch (error) {
    api(`repos/${repo}/check-runs/${check.id}`, { status: 'completed', conclusion: 'failure', output: {
      title: 'Required verification: incomplete', summary: 'Required plan authorization was blocked. See the authorization job; no passing coverage is claimed.' } }, 'PATCH');
    throw error;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function complete(repo, runId, expectedAttempt) {
  const { receipt, check, producer, upstream, current, known, jobs } = await readBinding(repo, runId);
  if (producer.run_attempt !== expectedAttempt) throw new Error('Completion event attempt mismatch');
  if (producer.event !== 'workflow_run' || producer.status !== 'completed') throw new Error('Not a completed chained producer');
  if (latestCheck(repo, receipt.sha)?.id !== check.id) throw new Error('A newer required plan supersedes this producer');
  const directory = await mkdtemp(join(tmpdir(), 'required-results-'));
  try {
    const artifacts = pages(`repos/${repo}/actions/runs/${producer.id}/artifacts`, 'artifacts');
    const results = [];
    for (const entry of receipt.plan.entries) {
      const name = `journey-result-${producer.run_attempt}-${entry.spec}`;
      try {
        const artifact = currentArtifact(artifacts, name, producer);
        const destination = join(directory, String(artifact.id));
        await download(repo, producer.id, name, destination);
        results.push(JSON.parse(await readFile(join(destination, 'journey-result.json'), 'utf8')));
      } catch { /* Missing/invalid evidence is incomplete, never a manufactured test failure. */ }
    }
    const summary = reconcile(receipt, { currentSha: current.head.sha, producer, jobs, results, trusted: true });
    upstreamIdentity(upstream, repo, known.upstream, api(`repos/${repo}/pulls/${receipt.pr}`));
    if (latestCheck(repo, receipt.sha)?.id !== check.id) throw new Error('Required plan superseded before completion');
    api(`repos/${repo}/check-runs/${check.id}`, { status: 'completed', conclusion: summary.state === 'passed' ? 'success' : 'failure',
      output: { title: `Required verification: ${summary.state}`, summary: summaryText(summary, producer.html_url), text: check.output.text } }, 'PATCH');
    await optionalPublication(() => comment(receipt, summary, producer.html_url));
    return { receipt, summary };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (process.argv[2] === 'authorize') await authorize(event, process.env.GITHUB_REPOSITORY);
  else if (process.argv[2] === 'complete') await complete(process.env.GITHUB_REPOSITORY, event.workflow_run.id, event.workflow_run.run_attempt);
  else throw new Error('Choose authorize or complete');
}
