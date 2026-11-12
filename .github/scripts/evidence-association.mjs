export function authorEvidenceNotice(run) {
  const login = run.triggering_actor?.login ?? run.actor?.login;
  const starter = typeof login === "string" && login.length <= 39 && /^[a-z\d]+(?:-[a-z\d]+)*(?![\s\S])/i.test(login) ? `Started by @${login}. ` : "";
  return `${starter}Author evidence: these tests run the PR's own code. Not a CI verification or merge gate.`;
}

// The only producer: the PR change proof run on the PR head.
export const producers = [
  { file: "pr-proof.yml", name: "PR change proof", events: ["pull_request", "workflow_dispatch"] },
];
const validSha = (sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha);
export const validId = (id) => Number.isSafeInteger(id) && id > 0;
export function sameRepo(value, repo) {
  const [owner, name] = repo.split("/");
  return value?.full_name === repo && value?.owner?.login === owner && value?.name === name;
}

// All identity comes from GitHub's API, never artifact contents or the event's first PR.
export async function association(run, repo, workflows, api, completed = true) {
  const producer = workflows.find((workflow) => workflow.id === run.workflow_id);
  if (!producer || run.path !== `.github/workflows/${producer.file}` || run.name !== producer.name)
    return { reason: "unrecognized producer workflow" };
  if (!sameRepo(run.repository, repo) || !sameRepo(run.head_repository, repo))
    return { reason: "producer repository identity mismatch" };
  if (!producer.events.includes(run.event) || (completed && (run.status !== "completed" || !["success", "failure"].includes(run.conclusion))))
    return { reason: "producer event or completion is not eligible" };
  let pulls = run.pull_requests;
  if (run.event === "workflow_dispatch") {
    if (!run.head_branch || !validSha(run.head_sha)) return { reason: "missing dispatch branch or SHA" };
    pulls = [];
    for (let page = 1; ; page++) {
      const candidates = await api(`repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${repo.split("/")[0]}:${run.head_branch}`)}&per_page=100&page=${page}`);
      if (!Array.isArray(candidates)) return { reason: "invalid open PR listing" };
      pulls.push(...candidates.filter(pr => pr.state === "open" && pr.head?.ref === run.head_branch && pr.head?.sha === run.head_sha
        && sameRepo(pr.head?.repo, repo) && sameRepo(pr.base?.repo, repo)
        && pr.head.repo.id === run.repository.id && pr.base.repo.id === run.repository.id));
      if (candidates.length < 100) break;
    }
  }
  if (!Array.isArray(pulls) || pulls.length !== 1)
    return { reason: "missing or ambiguous PR association" };
  const pr = pulls[0];
  // Run PR stubs expose repo IDs, not necessarily full repository objects.
  if (!validId(run.repository.id) || run.head_repository.id !== run.repository.id || pr.base?.repo?.id !== run.repository.id || pr.head?.repo?.id !== run.head_repository.id)
    return { reason: "PR base or head repository identity mismatch" };
  if (!validId(pr.number) || !validSha(pr.head?.sha))
    return { reason: "missing PR identity" };
  if (run.head_sha !== pr.head.sha)
    return { reason: "producer SHA differs from PR association" };
  return { pr: pr.number, sha: pr.head.sha };
}
