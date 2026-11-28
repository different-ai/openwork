import { createHash } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { and, desc, eq, gt, inArray, or } from "@openwork-ee/den-db/drizzle"
import { CloudCodingPullRequestTable as PullRequests, CloudCodingPushApprovalTable as Approvals, CloudCodingTaskTable as Tasks, MemberTable, AuthUserTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { CLOUD_CODING_APPROVAL_TTL_MS, CLOUD_CODING_SUMMARY_FILES_MAX, type CloudCodingChangeSet, type CloudCodingPushRequest } from "@openwork/types/den/cloud-coding"
import type { AuditChangeCapture } from "../../audit/request-capture.js"
import { db } from "../../db.js"
import { peopleMemberCondition } from "../../setup-agent-members.js"
import { getCloudCodingReadiness } from "../access.js"
import { cloudCodingAppConfig } from "../config.js"
import { CloudCodingGithubError } from "../github-api.js"
import { createRepositoryReadToken, readInstalledRepository } from "../installation.js"
import { getMemberGithubAccessToken } from "../links.js"
import { queueCloudCodingSlackNotice } from "../slack/notices.js"
import { requireCloudCodingTurn } from "./turn.js"
import { CLOUD_CODING_TASK_TOKEN_PREFIX, findCloudCodingTaskByToken, type CloudCodingTaskRow } from "../tasks.js"
import { cloudCodingApprovalView, expireCloudCodingApprovals, getCloudCodingApproval, getCloudCodingPullRequest, type CloudCodingApprovalRow } from "./approvals.js"
import { recordGatewayEvent } from "./audit.js"
import { didUpdate } from "./database.js"
import { planChangeSet } from "./change-set.js"
import { branchExists, githubGit, githubRefused } from "./github-git.js"
import { CloudCodingChangeRefusal, gitCommitSha, gitIdentityName, normalizeCommitMessage, planCommitTrees, type GitIdentity } from "./git-objects.js"

const closed = () => new CloudCodingChangeRefusal("task_closed", "This Cloud coding task has ended or expired. Ask OpenWork to start it again.")
const unavailable = () => new CloudCodingChangeRefusal("repository_not_available", "This repository is no longer available for Cloud coding.")
const notLinked = () => new CloudCodingChangeRefusal("account_not_linked", "Link your GitHub account to use Cloud coding.")
const used = () => new CloudCodingChangeRefusal("approval_used", "This approval has already been used or replaced. Ask for a new approval.")
const mismatch = () => new CloudCodingChangeRefusal("commit_mismatch", "The code changed after the person approved. Ask for a new approval.")

export async function findGatewayTask(token: string, finishedTask?: "opened" | "read"): Promise<CloudCodingTaskRow> {
  const task = await findCloudCodingTaskByToken({ token })
  if (task) return task
  if (finishedTask && token.startsWith(CLOUD_CODING_TASK_TOKEN_PREFIX)) {
    const [completed] = await db.$primary.select().from(Tasks).where(and(or(eq(Tasks.status, "pull_request_opened"),
      finishedTask === "read" ? and(eq(Tasks.status, "cancelled"), eq(Tasks.failureCode, "push_denied")) : undefined),
      gt(Tasks.tokenExpiresAt, new Date()), eq(Tasks.tokenHash, createHash("sha256").update(token).digest("hex")))).limit(1)
    if (completed) return completed
  }
  throw closed()
}

export async function requireGatewayMember(task: CloudCodingTaskRow) {
  const [member] = await db.$primary.select({ userId: AuthUserTable.id, name: AuthUserTable.name }).from(MemberTable)
    .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId)).where(and(eq(MemberTable.id, task.orgMembershipId),
      eq(MemberTable.organizationId, task.organizationId), peopleMemberCondition())).limit(1)
  if (!member) throw closed()
  return member
}

export async function prepareGatewayTask(task: CloudCodingTaskRow, member: Awaited<ReturnType<typeof requireGatewayMember>>) {
  await requireCloudCodingTurn(task)
  const scope = { organizationId: task.organizationId, memberId: task.orgMembershipId, taskId: task.id, githubRepositoryId: task.githubRepositoryId }
  const readiness = await getCloudCodingReadiness({ ...scope, userId: member.userId })
  switch (readiness.readiness) {
    case "feature_disabled": throw new CloudCodingChangeRefusal("feature_disabled", "Cloud coding is not available to you right now.")
    case "not_configured":
    case "github_not_connected": throw new CloudCodingChangeRefusal("github_not_connected", "Ask an organization admin to connect GitHub for Cloud coding.")
    case "turned_off": throw new CloudCodingChangeRefusal("turned_off", "Your organization has turned off Cloud coding.")
    case "not_allowed": throw new CloudCodingChangeRefusal("not_allowed", "Your organization has not given you access to Cloud coding.")
    case "github_suspended": throw new CloudCodingChangeRefusal("github_suspended", "GitHub suspended the connection for Cloud coding.")
    case "account_not_linked": throw notLinked()
  }
  const config = cloudCodingAppConfig()
  if (!config) throw new CloudCodingChangeRefusal("github_not_connected", "The GitHub connection is not set up.")
  const repository = await readInstalledRepository(scope)
  if (!repository || repository.archived) throw unavailable()
  const { link } = readiness
  const author = { name: gitIdentityName(link.authorName, link.githubLogin), email: link.commitEmail, login: link.githubLogin }
  return { task, scope, config, repository, author, member, cloneUrl: `${config.webBaseUrl}/${repository.fullName}.git` }
}

type Gateway = Awaited<ReturnType<typeof prepareGatewayTask>>

export function gatewayTaskView(gateway: Gateway) {
  return { taskId: gateway.task.id, repository: { fullName: gateway.repository.fullName, cloneUrl: gateway.cloneUrl,
    defaultBranch: gateway.repository.defaultBranch }, baseBranch: gateway.task.baseBranch, author: gateway.author }
}

export async function issueGatewayReadToken(gateway: Gateway) {
  try {
    const credential = await createRepositoryReadToken(gateway.scope)
    if (!credential) throw unavailable()
    return { ...credential, cloneUrl: gateway.cloneUrl }
  } catch (error) {
    if (error instanceof CloudCodingGithubError && [403, 404, 422].includes(error.status)) throw unavailable()
    throw error
  }
}

async function refreshGatewayTask(gateway: Gateway) {
  const [task] = await db.$primary.select().from(Tasks).where(and(eq(Tasks.id, gateway.task.id), gt(Tasks.tokenExpiresAt, new Date()), inArray(Tasks.status, ["running", "awaiting_approval", "pushed"]))).limit(1)
  if (!task || task.tokenHash !== gateway.task.tokenHash) throw closed()
  const fresh = await prepareGatewayTask(task, await requireGatewayMember(task))
  if (fresh.repository.fullName !== gateway.repository.fullName) throw unavailable()
  return fresh
}

async function readGit(gateway: Gateway) {
  const { token } = await issueGatewayReadToken(gateway)
  return githubGit({ config: gateway.config, token, fullName: gateway.repository.fullName })
}

function checkBranch(gateway: Gateway, branch: string) {
  if (branch === gateway.repository.defaultBranch || branch === gateway.task.baseBranch) {
    throw new CloudCodingChangeRefusal("default_branch_refused", "OpenWork cannot push to the branch this work started from or to the default branch. Choose a new branch.")
  }
}

async function plan(git: Awaited<ReturnType<typeof readGit>>, change: CloudCodingChangeSet, planned: ReturnType<typeof planChangeSet>, identity: GitIdentity, time: number) {
  const baseTreeSha = await git.readCommit(change.baseSha)
  const trees = await planCommitTrees({ baseTreeSha, files: planned.files, readTree: git.readTree })
  const message = normalizeCommitMessage(change.commitMessage)
  const headSha = gitCommitSha({ treeSha: trees.rootTreeSha, parentSha: change.baseSha, identity, time, message })
  return { ...trees, message, headSha }
}

export async function requestGatewayPush(gateway: Gateway, input: CloudCodingPushRequest, capture: AuditChangeCapture | null) {
  const change = input.changeSet
  const planned = planChangeSet(change)
  checkBranch(gateway, change.branch)
  const git = await readGit(gateway)
  if (await git.readBranch(change.branch)) throw branchExists()
  const now = Date.now()
  const commitTime = Math.floor(now / 1000)
  const commit = await plan(git, change, planned, gateway.author, commitTime)
  const row = await db.transaction(async tx => {
    const [task] = await tx.select().from(Tasks).where(eq(Tasks.id, gateway.task.id)).limit(1).for("update")
    if (!task || !["running", "awaiting_approval", "pushed"].includes(task.status) || !task.tokenExpiresAt || task.tokenExpiresAt <= new Date() || task.tokenHash !== gateway.task.tokenHash) throw closed()
    await expireCloudCodingApprovals(gateway.scope, tx)
    const [pending] = await tx.select().from(Approvals).where(and(eq(Approvals.taskId, task.id), eq(Approvals.status, "pending")))
      .orderBy(desc(Approvals.createdAt), desc(Approvals.id)).limit(1).for("update")
    if (pending && pending.baseSha === change.baseSha && pending.branch === change.branch && pending.treeSha === commit.rootTreeSha && pending.commitMessage === commit.message && pending.title === input.title) return pending
    await tx.update(Approvals).set({ status: "superseded" }).where(and(eq(Approvals.taskId, task.id), inArray(Approvals.status, ["pending", "approved"])))
    const id = createDenTypeId("cloudCodingPushApproval")
    await tx.insert(Approvals).values({ id, taskId: task.id, organizationId: task.organizationId, orgMembershipId: task.orgMembershipId,
      githubRepositoryId: task.githubRepositoryId, repositoryFullName: gateway.repository.fullName, branch: change.branch, baseBranch: task.baseBranch,
      baseSha: change.baseSha, treeSha: commit.rootTreeSha, headSha: commit.headSha, commitTime, authorName: gateway.author.name, authorEmail: gateway.author.email,
      commitMessage: commit.message, title: input.title, body: input.body ?? null, summary: { files: commit.changes.slice(0, CLOUD_CODING_SUMMARY_FILES_MAX), fileCount: commit.changes.length, tests: input.tests },
      expiresAt: new Date(now + CLOUD_CODING_APPROVAL_TTL_MS) })
    await tx.update(Tasks).set({ status: "awaiting_approval" }).where(eq(Tasks.id, task.id))
    const [inserted] = await tx.select().from(Approvals).where(eq(Approvals.id, id)).limit(1)
    if (!inserted) throw new Error("cloud_coding_approval_missing")
    await queueCloudCodingSlackNotice(tx, { approval: inserted, task })
    await recordGatewayEvent(tx, capture, "cloud_coding.push.requested", inserted)
    return inserted
  })
  return { approval: await cloudCodingApprovalView(row) }
}

async function approvalFor(gateway: Gateway, approvalId: string) {
  const row = await getCloudCodingApproval(gateway.scope, approvalId)
  if (!row) throw new CloudCodingChangeRefusal("approval_not_found", "This push approval could not be found.")
  return row
}

async function findGatewayTaskForPolling(gateway: Gateway) {
  const { task } = gateway
  if (!task.tokenHash) return null
  const [fresh] = await db.$primary.select().from(Tasks).where(and(eq(Tasks.id, task.id), eq(Tasks.tokenHash, task.tokenHash),
    gt(Tasks.tokenExpiresAt, new Date()), or(inArray(Tasks.status, ["running", "awaiting_approval", "pushed", "pull_request_opened"]),
      and(eq(Tasks.status, "cancelled"), eq(Tasks.failureCode, "push_denied"))))).limit(1)
  return fresh ?? null
}

export async function pollGatewayPush(gateway: Gateway, approvalId: string, waitMs: number, signal: AbortSignal) {
  const end = Date.now() + Math.min(25_000, Math.max(0, waitMs))
  let row = await approvalFor(gateway, approvalId)
  while (row.status === "pending" && Date.now() < end) {
    await sleep(Math.max(0, Math.min(1000, end - Date.now())), undefined, { signal })
    row = await approvalFor(gateway, approvalId)
  }
  if (waitMs > 0) {
    const task = await findGatewayTaskForPolling(gateway)
    if (!task) throw closed()
    await prepareGatewayTask(task, await requireGatewayMember(task))
  }
  return { approval: await cloudCodingApprovalView(row) }
}

function checkApprovalStatus(status: CloudCodingApprovalRow["status"]) {
  switch (status) {
    case "pending": throw new CloudCodingChangeRefusal("approval_pending", "The person has not approved this push yet.")
    case "denied": throw new CloudCodingChangeRefusal("approval_denied", "The person denied this push.")
    case "expired": throw new CloudCodingChangeRefusal("approval_expired", "This approval expired. Ask for a new approval.")
    case "superseded": throw used()
  }
}

function pushFailure(error: unknown, gateway: Gateway) {
  if (!(error instanceof CloudCodingGithubError)) return error
  return [403, 404].includes(error.status)
    ? githubRefused(`GitHub didn't accept the push. ${gateway.author.login} may not have write access to ${gateway.repository.fullName}.`)
    : githubRefused()
}

export async function pushGatewayCommit(gateway: Gateway, row: CloudCodingApprovalRow, change: CloudCodingChangeSet, capture: AuditChangeCapture | null) {
  checkApprovalStatus(row.status)
  if (change.branch !== row.branch || change.baseSha !== row.baseSha || normalizeCommitMessage(change.commitMessage) !== row.commitMessage) throw mismatch()
  checkBranch(gateway, change.branch)
  const planned = planChangeSet(change)
  const reader = await readGit(gateway)
  const identity = { name: row.authorName, email: row.authorEmail }
  const commit = await plan(reader, change, planned, identity, row.commitTime).catch(error => {
    if (error instanceof CloudCodingChangeRefusal && error.code === "no_changes") throw mismatch()
    throw error
  })
  if (commit.headSha !== row.headSha) throw mismatch()
  const currentSha = await reader.readBranch(row.branch)
  const finish = async (approval: CloudCodingApprovalRow) => {
    await db.transaction(async tx => {
      const result = await tx.update(Tasks).set({ status: "pushed" }).where(and(eq(Tasks.id, gateway.task.id), eq(Tasks.status, "awaiting_approval")))
      if (didUpdate(result)) await recordGatewayEvent(tx, capture, "cloud_coding.push.completed", { ...approval, repositoryFullName: gateway.repository.fullName })
    })
    return { approval: await cloudCodingApprovalView(approval), branch: approval.branch, headSha: approval.headSha }
  }
  if (row.status === "pushed") {
    if (currentSha !== row.headSha) throw used()
    return finish(row)
  }
  if (currentSha) {
    const current = await approvalFor(gateway, row.id)
    if (current.status === "pushed") {
      if (currentSha !== current.headSha) throw used()
      return finish(current)
    }
    throw branchExists()
  }
  const pushedAt = new Date()
  const claim = await db.update(Approvals).set({ status: "pushed", pushedAt }).where(and(eq(Approvals.id, row.id),
    eq(Approvals.status, "approved"), gt(Approvals.expiresAt, pushedAt)))
  if (!didUpdate(claim)) throw used()
  let attemptedRef = false
  try {
    checkBranch(await refreshGatewayTask(gateway), row.branch)
    const token = await getMemberGithubAccessToken(gateway.scope)
    if (!token) throw notLinked()
    const writer = githubGit({ config: gateway.config, token, fullName: gateway.repository.fullName })
    const written = new Set<string>()
    for (const file of planned.files) {
      if ("deleted" in file || written.has(file.blobSha)) continue
      const content = planned.contents.get(file.path)
      if (!content || await writer.createBlob(content) !== file.blobSha) throw mismatch()
      written.add(file.blobSha)
    }
    for (const tree of commit.newTrees) if (await writer.createTree(tree.entries) !== tree.sha) throw mismatch()
    if (await writer.createCommit({ treeSha: row.treeSha, baseSha: row.baseSha, time: row.commitTime, message: row.commitMessage, identity }) !== row.headSha) throw mismatch()
    checkBranch(await refreshGatewayTask(gateway), row.branch)
    attemptedRef = true
    await writer.createRef(row.branch, row.headSha)
  } catch (error) {
    const definite = error instanceof CloudCodingChangeRefusal || error instanceof CloudCodingGithubError && [401, 403, 404, 422].includes(error.status)
    if (!attemptedRef || definite) {
      await db.transaction(async tx => {
        const [task] = await tx.select().from(Tasks).where(eq(Tasks.id, gateway.task.id)).limit(1).for("update")
        const [latest] = await tx.select({ id: Approvals.id }).from(Approvals).where(eq(Approvals.taskId, gateway.task.id))
          .orderBy(desc(Approvals.createdAt), desc(Approvals.id)).limit(1).for("update")
        const status = task?.tokenHash !== gateway.task.tokenHash || row.expiresAt <= new Date() ? "expired"
          : latest?.id !== row.id ? "superseded" : "approved"
        await tx.update(Approvals).set({ status, pushedAt: null }).where(and(eq(Approvals.id, row.id), eq(Approvals.status, "pushed"), eq(Approvals.pushedAt, pushedAt)))
      })
    }
    throw pushFailure(error, gateway)
  }
  return finish({ ...row, status: "pushed", pushedAt })
}

export async function requireGatewayApproval(gateway: Gateway, approvalId: string) {
  return approvalFor(gateway, approvalId)
}

function pullRequestView(row: typeof PullRequests.$inferSelect) {
  return { number: row.number, url: row.url, title: row.title, repositoryFullName: row.repositoryFullName, branch: row.branch }
}

export async function openGatewayPullRequest(gateway: Gateway, approvalId: string, capture: AuditChangeCapture | null) {
  const approval = await approvalFor(gateway, approvalId)
  checkApprovalStatus(approval.status)
  if (approval.status !== "pushed") throw new CloudCodingChangeRefusal("approval_pending", "Push the approved branch before opening its pull request.")
  const existing = await getCloudCodingPullRequest(approval.id)
  if (existing) return pullRequestView(existing)
  if (gateway.task.status === "pull_request_opened") throw closed()
  const token = await getMemberGithubAccessToken(gateway.scope)
  if (!token) throw notLinked()
  const reader = await readGit(gateway)
  const writer = githubGit({ config: gateway.config, token, fullName: gateway.repository.fullName })
  const result = await db.transaction(async tx => {
    const [task] = await tx.select().from(Tasks).where(eq(Tasks.id, gateway.task.id)).limit(1).for("update")
    const recorded = await getCloudCodingPullRequest(approval.id, tx)
    if (recorded) return recorded
    if (!task || !["awaiting_approval", "pushed"].includes(task.status) || !task.tokenExpiresAt || task.tokenExpiresAt <= new Date() || task.tokenHash !== gateway.task.tokenHash) throw closed()
    if (await reader.readBranch(approval.branch) !== approval.headSha) throw used()
    const target = { branch: approval.branch, base: approval.baseBranch, headSha: approval.headSha }
    const pr = await writer.openPullRequest({ ...target, title: approval.title, body: approval.body }) ?? await writer.findPullRequest(target)
    if (!pr || pr.head.sha !== target.headSha || pr.head.ref !== target.branch || pr.base.ref !== target.base) throw githubRefused("GitHub did not open a pull request for the approved branch.")
    const row = { id: createDenTypeId("cloudCodingPullRequest"), approvalId: approval.id, taskId: task.id, organizationId: task.organizationId,
      openedByOrgMembershipId: task.orgMembershipId, openedByName: gateway.member.name, githubRepositoryId: task.githubRepositoryId,
      repositoryFullName: gateway.repository.fullName, number: pr.number, url: pr.html_url, title: pr.title, branch: approval.branch, headSha: approval.headSha,
      state: pr.merged_at ? "merged" : pr.state, openedAt: new Date(pr.created_at), closedAt: pr.closed_at ? new Date(pr.closed_at) : null, mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
      createdAt: new Date(), updatedAt: new Date() } as const
    await tx.insert(PullRequests).values(row)
    await tx.update(Tasks).set({ status: "pull_request_opened" }).where(eq(Tasks.id, task.id))
    await recordGatewayEvent(tx, capture, "cloud_coding.pull_request.opened", { ...row, id: approval.id })
    return row
  })
  return pullRequestView(result)
}
