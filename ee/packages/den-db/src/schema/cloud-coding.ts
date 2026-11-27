import { sql } from "drizzle-orm"
import { bigint, boolean, index, int, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { compatJsonColumn, denTypeIdColumn, encryptedTextColumn } from "../columns"

const createdAt = () => timestamp("created_at", { fsp: 3 }).notNull().defaultNow()
const updatedAt = () => timestamp("updated_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`)

/**
 * Cloud coding: one GitHub App installation per organization. The switch and
 * the "who can use it" default live here because they only exist while GitHub
 * is connected. Repositories are chosen on GitHub, never here.
 */
export const CloudCodingInstallationTable = mysqlTable(
  "cloud_coding_installation",
  {
    id: denTypeIdColumn("cloudCodingInstallation", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    githubInstallationId: bigint("github_installation_id", { mode: "number", unsigned: true }).notNull(),
    accountId: bigint("account_id", { mode: "number", unsigned: true }).notNull(),
    accountLogin: varchar("account_login", { length: 255 }).notNull(),
    accountType: mysqlEnum("account_type", ["Organization", "User"]).notNull(),
    repositorySelection: mysqlEnum("repository_selection", ["all", "selected"]).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    accessOrgWide: boolean("access_org_wide").notNull().default(true),
    suspendedAt: timestamp("suspended_at", { fsp: 3 }),
    connectedByOrgMembershipId: denTypeIdColumn("member", "connected_by_org_membership_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("cloud_coding_installation_org").on(table.organizationId),
    uniqueIndex("cloud_coding_installation_github").on(table.githubInstallationId),
  ],
)

/** The repositories the installation can reach, mirrored from GitHub so pages and checks do not call GitHub on every read. */
export const CloudCodingRepositoryTable = mysqlTable(
  "cloud_coding_repository",
  {
    id: denTypeIdColumn("cloudCodingRepository", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    installationId: denTypeIdColumn("cloudCodingInstallation", "installation_id").notNull(),
    githubRepositoryId: bigint("github_repository_id", { mode: "number", unsigned: true }).notNull(),
    fullName: varchar("full_name", { length: 255 }).notNull(),
    defaultBranch: varchar("default_branch", { length: 255 }),
    isPrivate: boolean("is_private").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("cloud_coding_repository_org_github").on(table.organizationId, table.githubRepositoryId),
    index("cloud_coding_repository_org_name").on(table.organizationId, table.fullName),
  ],
)

/** People and teams who may use Cloud coding when it is not on for everyone. */
export const CloudCodingAccessGrantTable = mysqlTable(
  "cloud_coding_access_grant",
  {
    id: denTypeIdColumn("cloudCodingAccessGrant", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id"),
    teamId: denTypeIdColumn("team", "team_id"),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("cloud_coding_access_grant_member").on(table.organizationId, table.orgMembershipId),
    uniqueIndex("cloud_coding_access_grant_team").on(table.organizationId, table.teamId),
  ],
)

/**
 * One person's own GitHub account for one organization (GitHub App
 * user-to-server tokens). Pushes and pull requests use this token so GitHub
 * shows the person as the author. Tokens are encrypted at rest and never leave
 * Den.
 */
export const CloudCodingGithubLinkTable = mysqlTable(
  "cloud_coding_github_link",
  {
    id: denTypeIdColumn("cloudCodingGithubLink", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id").notNull(),
    githubUserId: bigint("github_user_id", { mode: "number", unsigned: true }).notNull(),
    githubLogin: varchar("github_login", { length: 255 }).notNull(),
    githubName: varchar("github_name", { length: 255 }),
    commitEmail: varchar("commit_email", { length: 320 }).notNull(),
    accessToken: encryptedTextColumn("access_token").notNull(),
    refreshToken: encryptedTextColumn("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { fsp: 3 }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { fsp: 3 }),
    linkedAt: timestamp("linked_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("cloud_coding_github_link_member").on(table.orgMembershipId),
    uniqueIndex("cloud_coding_github_link_org_github_user").on(table.organizationId, table.githubUserId),
  ],
)

export const cloudCodingTaskStatusValues = ["created", "running", "awaiting_approval", "pushed", "pull_request_opened", "failed", "cancelled"] as const
export type CloudCodingTaskStatus = (typeof cloudCodingTaskStatusValues)[number]

/**
 * One request to change code in one repository, for one person. The cloud
 * computer doing the work holds only this task's token: it can read that one
 * repository and ask Den to push, nothing else. Only hashes of the setup code
 * and the token are stored.
 */
export const CloudCodingTaskTable = mysqlTable(
  "cloud_coding_task",
  {
    id: denTypeIdColumn("cloudCodingTask", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id").notNull(),
    repositoryId: denTypeIdColumn("cloudCodingRepository", "repository_id").notNull(),
    githubRepositoryId: bigint("github_repository_id", { mode: "number", unsigned: true }).notNull(),
    repositoryFullName: varchar("repository_full_name", { length: 255 }).notNull(),
    baseBranch: varchar("base_branch", { length: 255 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    status: mysqlEnum("status", cloudCodingTaskStatusValues).notNull().default("created"),
    setupCodeHash: varchar("setup_code_hash", { length: 64 }),
    setupCodeExpiresAt: timestamp("setup_code_expires_at", { fsp: 3 }),
    tokenHash: varchar("token_hash", { length: 64 }),
    tokenExpiresAt: timestamp("token_expires_at", { fsp: 3 }),
    remoteSessionId: varchar("remote_session_id", { length: 128 }),
    workerId: varchar("worker_id", { length: 64 }),
    failureCode: varchar("failure_code", { length: 64 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("cloud_coding_task_setup_code").on(table.setupCodeHash),
    uniqueIndex("cloud_coding_task_token").on(table.tokenHash),
    index("cloud_coding_task_member_status").on(table.organizationId, table.orgMembershipId, table.status),
  ],
)

export const cloudCodingPushApprovalStatusValues = ["pending", "approved", "denied", "pushed", "expired", "superseded"] as const
export type CloudCodingPushApprovalStatus = (typeof cloudCodingPushApprovalStatusValues)[number]

export type CloudCodingFileChange = { path: string; change: "added" | "modified" | "deleted" }
export type CloudCodingTestReport = { status: "passed" | "failed" | "not_run"; command: string | null; summary: string | null }
export type CloudCodingPushSummary = { files: CloudCodingFileChange[]; fileCount: number; tests: CloudCodingTestReport }

/**
 * One push waiting for the person who asked. It is bound to the exact commit
 * (`head_sha`, computed by Den from the files the cloud computer sent), can be
 * used once, and never holds file contents.
 */
export const CloudCodingPushApprovalTable = mysqlTable(
  "cloud_coding_push_approval",
  {
    id: denTypeIdColumn("cloudCodingPushApproval", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id").notNull(),
    taskId: denTypeIdColumn("cloudCodingTask", "task_id").notNull(),
    githubRepositoryId: bigint("github_repository_id", { mode: "number", unsigned: true }).notNull(),
    repositoryFullName: varchar("repository_full_name", { length: 255 }).notNull(),
    branch: varchar("branch", { length: 255 }).notNull(),
    baseBranch: varchar("base_branch", { length: 255 }).notNull(),
    baseSha: varchar("base_sha", { length: 40 }).notNull(),
    treeSha: varchar("tree_sha", { length: 40 }).notNull(),
    headSha: varchar("head_sha", { length: 40 }).notNull(),
    commitTime: int("commit_time", { unsigned: true }).notNull(),
    authorName: varchar("author_name", { length: 255 }).notNull(),
    authorEmail: varchar("author_email", { length: 320 }).notNull(),
    commitMessage: text("commit_message").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    body: text("body"),
    summary: compatJsonColumn<CloudCodingPushSummary>("summary").notNull(),
    status: mysqlEnum("status", cloudCodingPushApprovalStatusValues).notNull().default("pending"),
    decidedAt: timestamp("decided_at", { fsp: 3 }),
    pushedAt: timestamp("pushed_at", { fsp: 3 }),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("cloud_coding_push_approval_member_status").on(table.organizationId, table.orgMembershipId, table.status),
    index("cloud_coding_push_approval_task").on(table.taskId),
  ],
)

/** Pull requests opened through Cloud coding. State follows GitHub's pull_request webhook. */
export const CloudCodingPullRequestTable = mysqlTable(
  "cloud_coding_pull_request",
  {
    id: denTypeIdColumn("cloudCodingPullRequest", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    openedByOrgMembershipId: denTypeIdColumn("member", "opened_by_org_membership_id").notNull(),
    openedByName: varchar("opened_by_name", { length: 255 }).notNull(),
    approvalId: denTypeIdColumn("cloudCodingPushApproval", "approval_id").notNull(),
    taskId: denTypeIdColumn("cloudCodingTask", "task_id").notNull(),
    githubRepositoryId: bigint("github_repository_id", { mode: "number", unsigned: true }).notNull(),
    repositoryFullName: varchar("repository_full_name", { length: 255 }).notNull(),
    number: int("number", { unsigned: true }).notNull(),
    title: varchar("title", { length: 512 }).notNull(),
    url: varchar("url", { length: 1024 }).notNull(),
    branch: varchar("branch", { length: 255 }).notNull(),
    headSha: varchar("head_sha", { length: 40 }).notNull(),
    state: mysqlEnum("state", ["open", "merged", "closed"]).notNull().default("open"),
    openedAt: timestamp("opened_at", { fsp: 3 }).notNull().defaultNow(),
    mergedAt: timestamp("merged_at", { fsp: 3 }),
    closedAt: timestamp("closed_at", { fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("cloud_coding_pull_request_number").on(table.organizationId, table.githubRepositoryId, table.number),
    uniqueIndex("cloud_coding_pull_request_approval").on(table.approvalId),
    index("cloud_coding_pull_request_org_opened").on(table.organizationId, table.openedAt),
  ],
)
