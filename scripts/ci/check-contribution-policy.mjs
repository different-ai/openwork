const STATUS_CONTEXT = "contribution-policy-required"
const COMMIT_API_CEILING = 250
const FILE_API_CEILING = 3000
const SHA_PATTERN = /^[0-9a-f]{40}$/
const EMAIL_PATTERN = /^[^<>\s@]+@[^<>\s@]+$/
const FILE_STATUSES = new Set([
  "added",
  "removed",
  "modified",
  "renamed",
  "copied",
  "changed",
  "unchanged",
])
const SUPPORTED_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "edited",
  "ready_for_review",
  "converted_to_draft",
])

const SENSITIVE_PATHS = new Set([
  "LICENSE",
  "CONTRIBUTING.md",
  "CODEOWNERS",
  "docs/CODEOWNERS",
  ".github/CODEOWNERS",
  ".github/pull_request_template.md",
  ".github/workflows/contribution-policy.yml",
  "scripts/ci/check-contribution-policy.mjs",
  "scripts/ci/check-contribution-policy.test.mjs",
])

class CollectionError extends Error {}

function failedResult(errors, overrides = {}) {
  return {
    ok: false,
    dcoValid: false,
    eeChanged: null,
    sensitivePolicyChanged: null,
    errors,
    ...overrides,
  }
}

function isSha(value) {
  return typeof value === "string" && SHA_PATTERN.test(value)
}

function isRepositoryPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\0")
  )
}

function isEePath(path) {
  return path === "ee" || path.startsWith("ee/")
}

function isSensitivePolicyPath(path) {
  return (
    path === "legal" ||
    path.startsWith("legal/") ||
    path === ".github/workflows" ||
    path.startsWith(".github/workflows/") ||
    SENSITIVE_PATHS.has(path)
  )
}

function parseIdentity(value) {
  if (typeof value !== "string") return null
  const match = value.match(/^([^<>\r\n\0]+) <([^<>\s\0]+)>$/)
  if (!match) return null
  const [, name, email] = match
  if (name !== name.trim() || !EMAIL_PATTERN.test(email)) return null
  return { name, email, key: `${name}\0${email}` }
}

function parseFinalTrailers(message) {
  if (typeof message !== "string" || message.length === 0) {
    return { error: "commit message metadata is missing", trailers: [] }
  }

  const normalized = message.replaceAll("\r\n", "\n")
  if (normalized.includes("\r") || normalized.includes("\0")) {
    return { error: "commit message metadata is malformed", trailers: [] }
  }

  const lines = normalized.split("\n")
  while (lines.length > 0 && lines.at(-1).trim() === "") lines.pop()

  let separator = lines.length - 1
  while (separator >= 0 && lines[separator].trim() !== "") separator -= 1
  if (separator < 1 || !lines.slice(0, separator).some((line) => line.trim() !== "")) {
    return { error: "a separate final trailer block is required", trailers: [] }
  }

  const trailers = []
  for (const line of lines.slice(separator + 1)) {
    const match = line.trimEnd().match(/^([A-Za-z0-9][^:\s]*):[ \t]+(\S(?:.*\S)?)$/)
    if (!match) return { error: "the final trailer block is malformed", trailers: [] }
    trailers.push({ token: match[1].toLowerCase(), value: match[2] })
  }

  return { error: null, trailers }
}

function validateCommit(commit, index) {
  const prefix = `commit ${index + 1}`
  if (!commit || typeof commit !== "object") return [`${prefix}: metadata is missing`]
  if (!isSha(commit.sha)) return [`${prefix}: SHA metadata is malformed`]
  if (!commit.author || typeof commit.author !== "object") {
    return [`${prefix}: author metadata is missing`]
  }
  if (
    typeof commit.author.name !== "string" ||
    typeof commit.author.email !== "string"
  ) {
    return [`${prefix}: author metadata is malformed`]
  }

  const author = parseIdentity(`${commit.author.name} <${commit.author.email}>`)
  if (
    !author ||
    author.name !== commit.author.name ||
    author.email !== commit.author.email
  ) {
    return [`${prefix}: author metadata is malformed`]
  }

  const parsed = parseFinalTrailers(commit.message)
  if (parsed.error) return [`${prefix}: ${parsed.error}`]

  const errors = []
  const signoffs = new Set()
  const coauthors = []
  for (const trailer of parsed.trailers) {
    if (trailer.token !== "signed-off-by" && trailer.token !== "co-authored-by") continue
    const identity = parseIdentity(trailer.value)
    if (!identity) {
      errors.push(`${prefix}: ${trailer.token} identity is malformed`)
    } else if (trailer.token === "signed-off-by") {
      signoffs.add(identity.key)
    } else {
      coauthors.push(identity.key)
    }
  }

  if (!signoffs.has(author.key)) {
    errors.push(`${prefix}: author name and email lack an exact final-block sign-off`)
  }
  if (coauthors.some((coauthor) => !signoffs.has(coauthor))) {
    errors.push(`${prefix}: a co-author lacks an exact final-block sign-off`)
  }
  return errors
}

export function evaluateContributionPolicy(input) {
  if (!input || typeof input !== "object") {
    return failedResult(["pull request metadata is missing"])
  }

  const metadataErrors = []
  if (!isSha(input.baseSha) || !isSha(input.headSha)) {
    metadataErrors.push("pull request revision metadata is malformed")
  }
  if (!Number.isSafeInteger(input.commitCount) || input.commitCount < 1) {
    metadataErrors.push("commit count is missing or malformed")
  } else if (input.commitCount >= COMMIT_API_CEILING) {
    metadataErrors.push(`commit count reaches the ${COMMIT_API_CEILING}-commit API ceiling`)
  }
  if (!Number.isSafeInteger(input.fileCount) || input.fileCount < 0) {
    metadataErrors.push("changed-file count is missing or malformed")
  } else if (input.fileCount >= FILE_API_CEILING) {
    metadataErrors.push(`changed-file count reaches the ${FILE_API_CEILING}-file API ceiling`)
  }
  if (!Array.isArray(input.commits)) {
    metadataErrors.push("commit metadata is missing")
  } else if (Number.isSafeInteger(input.commitCount) && input.commits.length !== input.commitCount) {
    metadataErrors.push("commit metadata is truncated or inconsistent")
  }
  if (!Array.isArray(input.files)) {
    metadataErrors.push("changed-file metadata is missing")
  } else if (Number.isSafeInteger(input.fileCount) && input.files.length !== input.fileCount) {
    metadataErrors.push("changed-file metadata is truncated or inconsistent")
  }
  if (metadataErrors.length > 0) return failedResult(metadataErrors)

  const commitShas = new Set()
  const dcoErrors = []
  input.commits.forEach((commit, index) => {
    dcoErrors.push(...validateCommit(commit, index))
    if (commit && typeof commit === "object" && isSha(commit.sha)) {
      if (commitShas.has(commit.sha)) dcoErrors.push(`commit ${index + 1}: duplicate SHA metadata`)
      commitShas.add(commit.sha)
    }
  })
  if (input.commits.at(-1)?.sha !== input.headSha) {
    dcoErrors.push("commit metadata is not bound to the pull request head")
  }

  const pathErrors = []
  const currentPaths = new Set()
  const paths = []
  input.files.forEach((file, index) => {
    const prefix = `file ${index + 1}`
    if (!file || typeof file !== "object" || !isRepositoryPath(file.filename)) {
      pathErrors.push(`${prefix}: path metadata is missing or malformed`)
      return
    }
    if (!FILE_STATUSES.has(file.status)) {
      pathErrors.push(`${prefix}: status metadata is missing or malformed`)
    }
    if (currentPaths.has(file.filename)) pathErrors.push(`${prefix}: duplicate path metadata`)
    currentPaths.add(file.filename)
    paths.push(file.filename)

    if (file.previousFilename !== null && file.previousFilename !== undefined) {
      if (!isRepositoryPath(file.previousFilename)) {
        pathErrors.push(`${prefix}: previous path metadata is malformed`)
      } else {
        paths.push(file.previousFilename)
      }
    } else if (file.status === "renamed") {
      pathErrors.push(`${prefix}: renamed path lacks its previous path`)
    }
  })
  if (pathErrors.length > 0) {
    return failedResult([...dcoErrors, ...pathErrors], { dcoValid: dcoErrors.length === 0 })
  }

  const eeChanged = paths.some(isEePath)
  const sensitivePolicyChanged = paths.some(isSensitivePolicyPath)
  const errors = [...dcoErrors]
  if (eeChanged) {
    errors.push("CLA verification not configured; pending private verification for ee/ changes")
  }
  if (sensitivePolicyChanged) {
    errors.push("protected contribution-policy or license machinery requires configured ownership review")
  }

  return {
    ok: errors.length === 0,
    dcoValid: dcoErrors.length === 0,
    eeChanged,
    sensitivePolicyChanged,
    errors,
  }
}

function countFromPullRequest(pullRequest, field, ceiling, label, allowZero) {
  const value = pullRequest?.[field]
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new CollectionError(`${label} count is missing or malformed`)
  }
  if (value >= ceiling) throw new CollectionError(`${label} count reaches its API ceiling`)
  return value
}

function assertLiveRevision(pullRequest, revision) {
  if (
    !pullRequest ||
    pullRequest.number !== revision.pullNumber ||
    pullRequest.state !== "open" ||
    pullRequest.base?.sha !== revision.baseSha ||
    pullRequest.head?.sha !== revision.headSha ||
    pullRequest.base?.ref !== revision.baseRef ||
    pullRequest.head?.ref !== revision.headRef ||
    pullRequest.base?.repo?.full_name !== revision.repository ||
    pullRequest.head?.repo?.full_name !== revision.headRepository
  ) {
    throw new CollectionError("pull request revision changed during policy evaluation")
  }
}

export async function collectContributionPolicyInput({ github, revision }) {
  const request = {
    owner: revision.owner,
    repo: revision.repo,
    pull_number: revision.pullNumber,
  }
  const before = (await github.rest.pulls.get(request)).data
  assertLiveRevision(before, revision)
  const commitCount = countFromPullRequest(before, "commits", COMMIT_API_CEILING, "commit", false)
  const fileCount = countFromPullRequest(before, "changed_files", FILE_API_CEILING, "changed-file", true)

  const [commits, files] = await Promise.all([
    github.paginate(github.rest.pulls.listCommits, { ...request, per_page: 100 }),
    github.paginate(github.rest.pulls.listFiles, { ...request, per_page: 100 }),
  ])

  const after = (await github.rest.pulls.get(request)).data
  assertLiveRevision(after, revision)
  if (
    countFromPullRequest(after, "commits", COMMIT_API_CEILING, "commit", false) !== commitCount ||
    countFromPullRequest(after, "changed_files", FILE_API_CEILING, "changed-file", true) !== fileCount
  ) {
    throw new CollectionError("pull request counts changed during policy evaluation")
  }

  return {
    baseSha: revision.baseSha,
    headSha: revision.headSha,
    commitCount,
    fileCount,
    commits: commits.map((commit) => ({
      sha: commit?.sha,
      message: commit?.commit?.message,
      author: {
        name: commit?.commit?.author?.name,
        email: commit?.commit?.author?.email,
      },
    })),
    files: files.map((file) => ({
      filename: file?.filename,
      previousFilename: file?.previous_filename ?? null,
      status: file?.status,
    })),
  }
}

function eventRevision(context, eventSha, workflowSha) {
  const pullRequest = context?.payload?.pull_request
  const repository = `${context?.repo?.owner}/${context?.repo?.repo}`
  if (
    context?.eventName !== "pull_request_target" ||
    !SUPPORTED_ACTIONS.has(context?.payload?.action) ||
    !pullRequest ||
    !Number.isSafeInteger(pullRequest.number) ||
    context?.payload?.repository?.full_name !== repository ||
    pullRequest.base?.repo?.full_name !== repository ||
    typeof pullRequest.base?.ref !== "string" ||
    typeof pullRequest.head?.ref !== "string" ||
    typeof pullRequest.head?.repo?.full_name !== "string" ||
    !isSha(pullRequest.base?.sha) ||
    !isSha(pullRequest.head?.sha) ||
    context.sha !== pullRequest.base.sha ||
    eventSha !== pullRequest.base.sha ||
    workflowSha !== pullRequest.base.sha
  ) {
    throw new CollectionError("event revision is not bound to the trusted base SHA")
  }

  return {
    owner: context.repo.owner,
    repo: context.repo.repo,
    repository,
    pullNumber: pullRequest.number,
    baseSha: pullRequest.base.sha,
    headSha: pullRequest.head.sha,
    baseRef: pullRequest.base.ref,
    headRef: pullRequest.head.ref,
    headRepository: pullRequest.head.repo.full_name,
  }
}

function runCoordinates(runId, runAttempt, serverUrl, revision) {
  if (!/^[1-9][0-9]*$/.test(runId) || !/^[1-9][0-9]*$/.test(runAttempt)) {
    throw new CollectionError("workflow run coordinates are malformed")
  }
  let server
  try {
    server = new URL(serverUrl)
  } catch {
    throw new CollectionError("GitHub server URL is malformed")
  }
  if (server.protocol !== "https:" || server.pathname !== "/") {
    throw new CollectionError("GitHub server URL is not an HTTPS origin")
  }

  const prefix = `${server.origin}/${revision.repository}/actions/runs/`
  return {
    runId,
    runAttempt,
    prefix,
    targetUrl: `${prefix}${runId}/attempts/${runAttempt}`,
  }
}

async function policyStatuses(github, revision) {
  const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef, {
    owner: revision.owner,
    repo: revision.repo,
    ref: revision.headSha,
    per_page: 100,
  })
  if (!Array.isArray(statuses)) throw new CollectionError("commit status metadata is malformed")
  return statuses.filter((status) => status?.context === STATUS_CONTEXT)
}

function statusRunCoordinates(status, prefix) {
  if (typeof status?.target_url !== "string" || !status.target_url.startsWith(prefix)) return null
  const match = status.target_url.slice(prefix.length).match(/^([1-9][0-9]*)\/attempts\/([1-9][0-9]*)$/)
  return match ? { runId: match[1], runAttempt: match[2] } : null
}

function isLaterRun(candidate, current) {
  const candidateRun = BigInt(candidate.runId)
  const currentRun = BigInt(current.runId)
  return candidateRun > currentRun || (
    candidateRun === currentRun && BigInt(candidate.runAttempt) > BigInt(current.runAttempt)
  )
}

async function createStatus(github, revision, run, state, description) {
  await github.rest.repos.createCommitStatus({
    owner: revision.owner,
    repo: revision.repo,
    sha: revision.headSha,
    state,
    context: STATUS_CONTEXT,
    description,
    target_url: run.targetUrl,
  })
}

async function replaceCurrentPendingStatus(github, revision, run, state, description) {
  const statuses = await policyStatuses(github, revision)
  const latest = statuses[0]
  if (latest?.state !== "pending" || latest?.target_url !== run.targetUrl) return false
  await createStatus(github, revision, run, state, description)
  return true
}

export async function runContributionPolicy({
  github,
  context,
  core,
  eventSha,
  workflowSha,
  runId,
  runAttempt,
  serverUrl,
}) {
  let revision
  let run
  try {
    revision = eventRevision(context, eventSha, workflowSha)
    run = runCoordinates(runId, runAttempt, serverUrl, revision)
    const existing = await policyStatuses(github, revision)
    if (existing.some((status) => {
      const coordinates = statusRunCoordinates(status, run.prefix)
      return coordinates && isLaterRun(coordinates, run)
    })) {
      core.notice("A newer contribution-policy run already owns this head status; this run is stale.")
      return { ok: false, stale: true }
    }
    await createStatus(
      github,
      revision,
      run,
      "pending",
      `run ${runId}/${runAttempt}: evaluating DCO and CLA scope`,
    )
  } catch {
    core.setFailed("Contribution policy could not establish a trusted event and status binding.")
    return { ok: false, stale: false }
  }

  let result
  try {
    const input = await collectContributionPolicyInput({ github, revision })
    result = evaluateContributionPolicy(input)
    core.info(`DCO evaluated for ${input.commitCount} commit(s).`)
    core.info(`EE path present: ${result.eeChanged === true ? "yes" : "no"}.`)
  } catch {
    try {
      await replaceCurrentPendingStatus(
        github,
        revision,
        run,
        "failure",
        "Contribution metadata collection failed closed",
      )
    } catch {
      // Preserve the pending status when a safe final write cannot be established.
    }
    core.setFailed("Contribution metadata collection failed closed; no success status was published.")
    return { ok: false, stale: false }
  }

  let published
  try {
    published = await replaceCurrentPendingStatus(
      github,
      revision,
      run,
      result.ok ? "success" : "failure",
      result.ok
        ? "DCO passed; EE CLA review not applicable"
        : "Contribution policy failed; see workflow run",
    )
  } catch {
    core.setFailed("The pending head status could not be finalized safely; no success was assumed.")
    return { ...result, ok: false, stale: false }
  }

  if (!published) {
    core.setFailed("A newer or unrelated status replaced this run's pending head status.")
    return { ...result, ok: false, stale: true }
  }
  if (!result.ok) core.setFailed(result.errors.join("; "))
  return { ...result, stale: false }
}
