// GitHub supplies author_association; repository write access alone does not
// make an outside collaborator an organization member. Missing metadata keeps
// the existing reviewer gate. Forks remain unsupported by the proof jobs.
export function internalProofContributor(pullRequest, repository) {
  if (repository?.owner?.type !== "Organization" ||
      !Number.isSafeInteger(repository.id) || repository.id <= 0 ||
      typeof repository.full_name !== "string" || !repository.full_name ||
      !["MEMBER", "OWNER"].includes(pullRequest?.author_association) ||
      pullRequest.user?.type !== "User") return false;
  return [pullRequest.head?.repo, pullRequest.base?.repo].every(candidate =>
    candidate?.id === repository.id && candidate.full_name === repository.full_name && candidate.fork === false);
}
