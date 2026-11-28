import { z } from "zod"

const timestampSchema = z.string().datetime({ offset: true })
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/)

export const CLOUD_CODING_CONNECTION_ID = "github-cloud-coding"
export const CLOUD_CODING_CONNECTION_NAME = "GitHub"

/** Limits on one push. A change that needs more is split by the person, not by raising these. */
export const CLOUD_CODING_MAX_CHANGED_FILES = 300
export const CLOUD_CODING_MAX_FILE_BYTES = 1_000_000
export const CLOUD_CODING_MAX_TOTAL_BYTES = 8_000_000
export const CLOUD_CODING_SUMMARY_FILES_MAX = 200
export const CLOUD_CODING_APPROVAL_TTL_MS = 24 * 60 * 60_000
export const CLOUD_CODING_TASK_TOKEN_TTL_MS = 60 * 60_000
export const CLOUD_CODING_SETUP_CODE_TTL_MS = 10 * 60_000

export const CLOUD_CODING_SURFACES = ["workbot", "slack", "web"] as const
export type CloudCodingSurface = (typeof CLOUD_CODING_SURFACES)[number]

export const CLOUD_CODING_WORKER_ID_HEADER = "x-openwork-cloud-worker-id"
export const CLOUD_CODING_WORKER_PROOF_HEADER = "x-openwork-cloud-worker-proof"
export const CLOUD_CODING_WORKER_PROOF_VERSION = "v1"

export function cloudCodingWorkerProofMessage(workerId: string, bearerSha256Hex: string): string {
  return `openwork-cloud-worker-proof:${CLOUD_CODING_WORKER_PROOF_VERSION}:${workerId}:${bearerSha256Hex}`
}

export const CLOUD_CODING_SLACK_ACTION_PREFIX = "cloud_coding_approval:"

export const cloudCodingAccessSchema = z.object({
  orgWide: z.boolean(),
  memberIds: z.array(z.string().min(1).max(64)).max(500),
  teamIds: z.array(z.string().min(1).max(64)).max(200),
}).meta({ ref: "CloudCodingAccess" })
export type CloudCodingAccess = z.infer<typeof cloudCodingAccessSchema>

export const cloudCodingConnectionSchema = z.object({
  accountLogin: z.string(),
  accountType: z.enum(["Organization", "User"]),
  repositorySelection: z.enum(["all", "selected"]),
  settingsUrl: z.string().url(),
  connectedAt: timestampSchema,
  suspended: z.boolean(),
}).meta({ ref: "CloudCodingConnection" })
export type CloudCodingConnection = z.infer<typeof cloudCodingConnectionSchema>

export const cloudCodingRepositorySchema = z.object({
  id: z.string(),
  fullName: z.string(),
  private: z.boolean(),
  defaultBranch: z.string().nullable(),
  pullRequestCount: z.number().int().nonnegative(),
}).meta({ ref: "CloudCodingRepository" })
export type CloudCodingRepository = z.infer<typeof cloudCodingRepositorySchema>

export const cloudCodingGithubIdentitySchema = z.object({
  login: z.string(),
  linkedAt: timestampSchema,
}).meta({ ref: "CloudCodingGithubIdentity" })
export type CloudCodingGithubIdentity = z.infer<typeof cloudCodingGithubIdentitySchema>

export const cloudCodingPersonSchema = z.object({
  memberId: z.string(),
  name: z.string(),
  email: z.string(),
  isYou: z.boolean(),
  canUse: z.boolean(),
  github: cloudCodingGithubIdentitySchema.nullable(),
}).meta({ ref: "CloudCodingPerson" })
export type CloudCodingPerson = z.infer<typeof cloudCodingPersonSchema>

export const cloudCodingPullRequestStateSchema = z.enum(["open", "merged", "closed"]).meta({ ref: "CloudCodingPullRequestState" })
export type CloudCodingPullRequestState = z.infer<typeof cloudCodingPullRequestStateSchema>

export const cloudCodingPullRequestSchema = z.object({
  id: z.string(),
  title: z.string(),
  repositoryFullName: z.string(),
  number: z.number().int().positive(),
  url: z.string().url(),
  state: cloudCodingPullRequestStateSchema,
  openedBy: z.object({ memberId: z.string(), name: z.string() }),
  openedAt: timestampSchema,
}).meta({ ref: "CloudCodingPullRequest" })
export type CloudCodingPullRequest = z.infer<typeof cloudCodingPullRequestSchema>

/** `GET /v1/cloud-coding`: everything the Cloud coding page shows. */
export const cloudCodingOverviewSchema = z.object({
  configured: z.boolean(),
  canManage: z.boolean(),
  connection: cloudCodingConnectionSchema.nullable(),
  enabled: z.boolean(),
  access: cloudCodingAccessSchema,
  repositories: z.array(cloudCodingRepositorySchema),
  people: z.array(cloudCodingPersonSchema),
  pullRequests: z.array(cloudCodingPullRequestSchema),
  me: z.object({
    memberId: z.string(),
    canUse: z.boolean(),
    github: cloudCodingGithubIdentitySchema.nullable(),
  }),
}).meta({ ref: "CloudCodingOverview" })
export type CloudCodingOverview = z.infer<typeof cloudCodingOverviewSchema>

/** `PUT /v1/cloud-coding/settings`. */
export const cloudCodingSettingsInputSchema = z.object({
  enabled: z.boolean().optional(),
  access: cloudCodingAccessSchema.optional(),
}).strict().refine((value) => value.enabled !== undefined || value.access !== undefined, "Send enabled or access.")
  .meta({ ref: "CloudCodingSettingsInput" })
export type CloudCodingSettingsInput = z.infer<typeof cloudCodingSettingsInputSchema>

/** `POST /v1/cloud-coding/github/install/start` and `POST /v1/cloud-coding/github/link/start`. */
export const cloudCodingRedirectSchema = z.object({ redirectUrl: z.string().url() }).meta({ ref: "CloudCodingRedirect" })
export type CloudCodingRedirect = z.infer<typeof cloudCodingRedirectSchema>

/** `POST /v1/cloud-coding/github/install/start`. `existing` finishes connecting an app that is already installed on GitHub. */
export const cloudCodingInstallStartInputSchema = z.object({ existing: z.boolean().optional() }).strict()
  .meta({ ref: "CloudCodingInstallStartInput" })

/** `GET /v1/cloud-coding/github/installations`: GitHub accounts the caller can connect, when there is more than one. */
export const cloudCodingInstallationChoiceSchema = z.object({
  installationId: z.number().int().positive(),
  accountLogin: z.string(),
  accountType: z.enum(["Organization", "User"]),
}).meta({ ref: "CloudCodingInstallationChoice" })
export type CloudCodingInstallationChoice = z.infer<typeof cloudCodingInstallationChoiceSchema>

export const cloudCodingInstallationChoicesSchema = z.object({ installations: z.array(cloudCodingInstallationChoiceSchema) })
  .meta({ ref: "CloudCodingInstallationChoices" })

/** `POST /v1/cloud-coding/github/install/complete`. */
export const cloudCodingInstallCompleteInputSchema = z.object({ installationId: z.number().int().positive() }).strict()
  .meta({ ref: "CloudCodingInstallCompleteInput" })

/**
 * Where GitHub's callback sends the browser in Den web, as `?github=<outcome>`
 * (plus `&reason=<code>` on `error`) on `/dashboard/cloud-coding` for a
 * connect and `/dashboard/cloud-coding/link` for a personal link.
 */
export const CLOUD_CODING_CALLBACK_OUTCOMES = ["connected", "linked", "choose", "error"] as const
export const CLOUD_CODING_CALLBACK_ERROR_REASONS = [
  "state_invalid",
  "different_account",
  "not_configured",
  "not_allowed",
  "not_installed",
  "not_your_installation",
  "installation_in_use",
  "account_in_use",
  "github_error",
] as const
export type CloudCodingCallbackErrorReason = (typeof CLOUD_CODING_CALLBACK_ERROR_REASONS)[number]

export const cloudCodingGithubCallbackInputSchema = z.object({
  code: z.string().min(1).max(500),
  state: z.string().min(1).max(4000),
  installationId: z.number().int().positive().optional(),
}).strict().meta({ ref: "CloudCodingGithubCallbackInput" })
export type CloudCodingGithubCallbackInput = z.infer<typeof cloudCodingGithubCallbackInputSchema>

export const cloudCodingGithubCallbackResultSchema = z.object({
  outcome: z.enum(["connected", "linked", "choose", "install"]),
  redirectUrl: z.string().url().optional(),
}).meta({ ref: "CloudCodingGithubCallbackResult" })
export type CloudCodingGithubCallbackResult = z.infer<typeof cloudCodingGithubCallbackResultSchema>

/**
 * Why a person cannot use Cloud coding right now, in the order checked. The
 * first one that applies is returned; `ready` means a task can start.
 */
export const cloudCodingReadinessSchema = z.enum([
  "ready",
  "feature_disabled",
  "not_configured",
  "github_not_connected",
  "turned_off",
  "not_allowed",
  "github_suspended",
  "account_not_linked",
]).meta({ ref: "CloudCodingReadiness" })
export type CloudCodingReadiness = z.infer<typeof cloudCodingReadinessSchema>

export const cloudCodingFileChangeSchema = z.object({
  path: z.string(),
  change: z.enum(["added", "modified", "deleted"]),
}).meta({ ref: "CloudCodingFileChange" })
export type CloudCodingFileChange = z.infer<typeof cloudCodingFileChangeSchema>

export const cloudCodingTestReportSchema = z.object({
  status: z.enum(["passed", "failed", "not_run"]),
  command: z.string().max(500).nullable(),
  summary: z.string().max(500).nullable(),
}).meta({ ref: "CloudCodingTestReport" })
export type CloudCodingTestReport = z.infer<typeof cloudCodingTestReportSchema>

export const cloudCodingPushApprovalStatusSchema = z.enum(["pending", "approved", "denied", "pushed", "expired", "superseded"])
  .meta({ ref: "CloudCodingPushApprovalStatus" })
export type CloudCodingPushApprovalStatus = z.infer<typeof cloudCodingPushApprovalStatusSchema>

/** One push waiting for (or decided by) the person who asked. Never holds file contents. */
export const cloudCodingPushApprovalSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  status: cloudCodingPushApprovalStatusSchema,
  repositoryFullName: z.string(),
  branch: z.string(),
  baseBranch: z.string(),
  headSha: shaSchema,
  title: z.string(),
  files: z.array(cloudCodingFileChangeSchema),
  fileCount: z.number().int().nonnegative(),
  tests: cloudCodingTestReportSchema,
  requestedAt: timestampSchema,
  expiresAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
  pullRequest: z.object({
    number: z.number().int().positive(),
    url: z.string().url(),
    state: cloudCodingPullRequestStateSchema,
  }).nullable(),
}).meta({ ref: "CloudCodingPushApproval" })
export type CloudCodingPushApproval = z.infer<typeof cloudCodingPushApprovalSchema>

export const cloudCodingPushApprovalListSchema = z.object({ approvals: z.array(cloudCodingPushApprovalSchema) })
  .meta({ ref: "CloudCodingPushApprovalList" })
export type CloudCodingPushApprovalList = z.infer<typeof cloudCodingPushApprovalListSchema>

/** `POST /v1/cloud-coding/approvals/:approvalId/decision`. There is no "always allow": every push asks. */
export const cloudCodingPushDecisionInputSchema = z.object({ decision: z.enum(["allow_once", "deny"]) }).strict()
  .meta({ ref: "CloudCodingPushDecisionInput" })
export type CloudCodingPushDecisionInput = z.infer<typeof cloudCodingPushDecisionInputSchema>


const repositoryPathSchema = z.string().min(1).max(1024)

/** One changed file. `mode` is a git file mode; symlinks and submodules are refused. */
export const cloudCodingChangedFileSchema = z.union([
  z.object({
    path: repositoryPathSchema,
    mode: z.enum(["100644", "100755"]),
    contentBase64: z.string(),
  }).strict(),
  z.object({ path: repositoryPathSchema, deleted: z.literal(true) }).strict(),
]).meta({ ref: "CloudCodingChangedFile" })
export type CloudCodingChangedFile = z.infer<typeof cloudCodingChangedFileSchema>

/**
 * The exact change to push: files relative to `baseSha`, on a new `branch`.
 * Den computes the commit from this alone, so sending it again at push time
 * proves the push is the approved one.
 */
export const cloudCodingChangeSetSchema = z.object({
  branch: z.string().min(1).max(200),
  baseSha: shaSchema,
  commitMessage: z.string().min(1).max(10_000),
  files: z.array(cloudCodingChangedFileSchema).min(1).max(CLOUD_CODING_MAX_CHANGED_FILES),
}).strict().meta({ ref: "CloudCodingChangeSet" })
export type CloudCodingChangeSet = z.infer<typeof cloudCodingChangeSetSchema>

/** `POST /v1/cloud-coding/gateway/push-approvals`. */
export const cloudCodingPushRequestSchema = z.object({
  changeSet: cloudCodingChangeSetSchema,
  title: z.string().min(1).max(255),
  body: z.string().max(20_000).optional(),
  tests: cloudCodingTestReportSchema,
}).strict().meta({ ref: "CloudCodingPushRequest" })
export type CloudCodingPushRequest = z.infer<typeof cloudCodingPushRequestSchema>

/** `POST /v1/cloud-coding/gateway/push-approvals/:approvalId/push`. */
export const cloudCodingPushInputSchema = z.object({ changeSet: cloudCodingChangeSetSchema }).strict()
  .meta({ ref: "CloudCodingPushInput" })
export type CloudCodingPushInput = z.infer<typeof cloudCodingPushInputSchema>

/** `POST /v1/cloud-coding/gateway/setup`: trades the one-time setup code for the task token. */
export const cloudCodingGatewaySetupInputSchema = z.object({ code: z.string().min(16).max(200) }).strict()
  .meta({ ref: "CloudCodingGatewaySetupInput" })

export const cloudCodingGatewayTaskSchema = z.object({
  taskId: z.string(),
  repository: z.object({ fullName: z.string(), cloneUrl: z.string().url(), defaultBranch: z.string() }),
  baseBranch: z.string(),
  author: z.object({ name: z.string(), email: z.string(), login: z.string() }),
}).meta({ ref: "CloudCodingGatewayTask" })
export type CloudCodingGatewayTask = z.infer<typeof cloudCodingGatewayTaskSchema>

export const cloudCodingGatewaySetupSchema = cloudCodingGatewayTaskSchema.extend({
  token: z.string(),
  tokenExpiresAt: timestampSchema,
}).meta({ ref: "CloudCodingGatewaySetup" })
export type CloudCodingGatewaySetup = z.infer<typeof cloudCodingGatewaySetupSchema>

/** `POST /v1/cloud-coding/gateway/read-token`: a short-lived token that can only read this one repository. */
export const cloudCodingReadTokenSchema = z.object({
  token: z.string(),
  expiresAt: timestampSchema,
  cloneUrl: z.string().url(),
}).meta({ ref: "CloudCodingReadToken" })
export type CloudCodingReadToken = z.infer<typeof cloudCodingReadTokenSchema>

export const cloudCodingPushResultSchema = z.object({
  approval: cloudCodingPushApprovalSchema,
  branch: z.string(),
  headSha: shaSchema,
}).meta({ ref: "CloudCodingPushResult" })
export type CloudCodingPushResult = z.infer<typeof cloudCodingPushResultSchema>

/** `POST /v1/cloud-coding/gateway/pull-requests`. */
export const cloudCodingOpenPullRequestInputSchema = z.object({ approvalId: z.string().min(1).max(64) }).strict()
  .meta({ ref: "CloudCodingOpenPullRequestInput" })

export const cloudCodingOpenedPullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  repositoryFullName: z.string(),
  branch: z.string(),
}).meta({ ref: "CloudCodingOpenedPullRequest" })
export type CloudCodingOpenedPullRequest = z.infer<typeof cloudCodingOpenedPullRequestSchema>

/**
 * Why the gateway refused. Each is a stable `error` code on a 4xx response
 * with a plain `message` the helper prints for the agent.
 */
export const CLOUD_CODING_GATEWAY_REFUSALS = [
  "feature_disabled",
  "turned_off",
  "not_allowed",
  "github_not_connected",
  "github_suspended",
  "account_not_linked",
  "repository_not_available",
  "task_closed",
  "invalid_branch",
  "default_branch_refused",
  "branch_exists",
  "base_not_found",
  "workflow_files_refused",
  "path_refused",
  "file_mode_refused",
  "change_too_large",
  "no_changes",
  "approval_not_found",
  "approval_pending",
  "approval_denied",
  "approval_expired",
  "approval_used",
  "commit_mismatch",
  "github_refused",
] as const
export type CloudCodingGatewayRefusal = (typeof CLOUD_CODING_GATEWAY_REFUSALS)[number]
