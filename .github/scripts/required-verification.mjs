import { createHash } from 'node:crypto';
import { classify } from '../../evals/scripts/journey-report.mjs';

export const CHECK = 'Required verification';
export const POLICY = 'critical-and-changed-specs/v1';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const externalId = receipt => `required-v1:${receipt.producer.id}:${receipt.producer.attempt}`;
const id = value => Number.isSafeInteger(value) && value > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export function validateRun(run, repo, workflow, attempt) {
  if (!id(run?.id) || !id(run.run_attempt) || run.run_attempt !== attempt ||
      run.repository?.full_name !== repo || run.head_repository?.full_name !== repo ||
      run.repository?.id !== run.head_repository?.id || !id(run.repository?.id) ||
      run.workflow_id !== workflow.id || run.path !== workflow.path)
    throw new Error('Run repository, workflow or attempt is not trusted');
}

export function upstreamIdentity(run, repo, workflow, current) {
  validateRun(run, repo, workflow, run.run_attempt);
  if (run.event !== 'pull_request' || run.status !== 'completed' || run.conclusion !== 'success' || !sha(run.head_sha))
    throw new Error('Warden must be a successful PR-triggered run');
  const matches = (run.pull_requests ?? []).filter(pr => pr.base?.repo?.id === run.repository.id);
  if (matches.length !== 1 || !id(matches[0].number) || matches[0].head?.repo?.id !== run.repository.id || matches[0].head?.sha !== run.head_sha)
    throw new Error('Missing or ambiguous same-repository PR association');
  if (current.number !== matches[0].number || current.state !== 'open' || current.base?.repo?.full_name !== repo ||
      current.head?.repo?.full_name !== repo || current.head?.sha !== run.head_sha)
    throw new Error('PR head or repository changed');
  return { pr: current.number, sha: current.head.sha };
}

// The check's authenticated write, not the downloaded JSON, authorizes this receipt.
export function validateReceipt(receipt, check, producer, upstream, current, workflows) {
  if (receipt?.version !== 1 || receipt.policy !== POLICY || !sha(receipt.sha) || !id(receipt.pr) || !Array.isArray(receipt.plan?.entries))
    throw new Error('Unsupported required plan');
  validateRun(producer, receipt.repo, workflows.producer, receipt.producer?.attempt);
  if (producer.id !== receipt.producer.id || producer.event !== 'workflow_run' || upstream.id !== receipt.upstream?.id)
    throw new Error('Producer/upstream binding mismatch');
  validateRun(upstream, receipt.repo, workflows.upstream, receipt.upstream.attempt);
  const identity = upstreamIdentity(upstream, receipt.repo, workflows.upstream, current);
  if (identity.pr !== receipt.pr || identity.sha !== receipt.sha || check?.name !== CHECK || check.head_sha !== receipt.sha ||
      check.app?.slug !== 'github-actions' || check.external_id !== externalId(receipt) ||
      check.details_url !== producer.html_url || check.output?.text !== `Receipt SHA256: ${digest(receipt)}`)
    throw new Error('Required plan has no authenticated controller endorsement');
  return identity;
}

export function reconcile(receipt, { currentSha, producer, jobs = [], results = [], trusted = false }) {
  const missing = [];
  const failed = [];
  const entries = receipt?.plan?.entries ?? [];
  if (!trusted || currentSha !== receipt.sha || producer.id !== receipt.producer?.id || producer.run_attempt !== receipt.producer?.attempt)
    return { state: 'incomplete', missing: ['Untrusted, stale or wrong-attempt required plan'], failed };
  const keys = entries.map(entry => JSON.stringify([entry.spec, entry.engine ?? null, entry.placement]));
  if (!entries.length || new Set(keys).size !== keys.length || receipt.plan.unresolved?.length)
    missing.push('Required plan is empty, duplicated or has unresolved metadata');
  for (const entry of entries) {
    const label = entry.spec;
    if (typeof label !== 'string' || !['local', 'daytona'].includes(entry.placement) || !entry.name ||
        (entry.engine !== undefined && !['v1', 'v2'].includes(entry.engine))) {
      missing.push('Unresolved required execution metadata');
      continue;
    }
    const matchingJobs = jobs.filter(job => job.name === `Journey — ${entry.name}`);
    const matching = results.filter(result => result.spec === label);
    const job = matchingJobs.length === 1 ? matchingJobs[0] : undefined;
    const execution = job?.steps?.find(step => ['Run E2E spec', 'Run user journey'].includes(step.name));
    const vision = job?.steps?.find(step => step.name === 'Judge deferred vision claims');
    if (matching.length !== 1 || !job || job.status !== 'completed') { missing.push(label); continue; }
    const result = matching[0];
    const summary = result.summary;
    if (result.sha !== receipt.sha || result.runId !== producer.id || result.attempt !== producer.run_attempt ||
        summary?.placement !== entry.placement || (entry.engine !== undefined && summary?.engine !== entry.engine) ||
        (entry.placement === 'daytona' && summary?.sandboxSha !== receipt.sha)) { missing.push(label); continue; }
    const visionResult = vision?.conclusion === 'success' ? 'success' : result.vision === 'failure' ? 'failure' : undefined;
    const status = classify(summary, execution?.conclusion, visionResult, label);
    if (status === 'failed') failed.push(label);
    else if (status !== 'passed' || job.conclusion !== 'success') missing.push(label);
  }
  const state = failed.length ? 'failed' : missing.length
    ? producer.status === 'completed' ? 'incomplete' : jobs.some(job => job.status === 'in_progress') ? 'running' : 'waiting'
    : producer.status !== 'completed' ? 'running' : producer.conclusion === 'success' ? 'passed' : 'incomplete';
  return { state, missing, failed };
}

export function summaryText(summary, url) {
  return `Required verification: **${summary.state}**. Selected evidence is separate.\n\n${summary.missing.length ? `Missing required specs: ${summary.missing.join(', ')}.\n\n` : ''}${summary.failed.length ? `Failed required specs: ${summary.failed.join(', ')}.\n\n` : ''}[Required journey jobs](${url})`;
}
