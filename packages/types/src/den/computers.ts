import { z } from "zod"
import { REMOTE_DEVICE_AVAILABILITIES, REMOTE_DEVICE_PROVIDERS } from "@openwork/types/den/remote-devices"

export const COMPUTER_KINDS = ["cloud_sandbox", "registered_vm", "member_machine"] as const
export type ComputerKind = (typeof COMPUTER_KINDS)[number]

export const COMPUTER_ROLES = ["source", "target"] as const
export type ComputerRole = (typeof COMPUTER_ROLES)[number]

export const COMPUTER_EXECUTABLE_VM_PROVIDERS = ["daytona", "freestyle"] as const
export function isExecutableVmProvider(provider: unknown): provider is (typeof COMPUTER_EXECUTABLE_VM_PROVIDERS)[number] {
  return COMPUTER_EXECUTABLE_VM_PROVIDERS.some((candidate) => candidate === provider)
}

export const computerSchema = z.object({
  id: z.string(),
  kind: z.enum(COMPUTER_KINDS),
  provider: z.enum(REMOTE_DEVICE_PROVIDERS),
  label: z.string(),
  ownerMemberId: z.string().nullable(),
  availability: z.enum(REMOTE_DEVICE_AVAILABILITIES),
}).meta({ ref: "Computer" })
export type Computer = z.infer<typeof computerSchema>

export const computerFolderSchema = z.string().min(1).max(1024).refine((path) =>
  path.startsWith("/") && !path.endsWith("/") && !/[\\\p{Cc}]/u.test(path)
    && path.slice(1).split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  "Use an absolute POSIX folder path without trailing slashes, empty segments, dot segments, backslashes or control characters.",
)
export type ComputerFolder = z.infer<typeof computerFolderSchema>

function sharedFoldersSchema(max: number) {
  return z.array(computerFolderSchema).max(max).refine(
    (folders) => new Set(folders).size === folders.length,
    "List each shared folder only once.",
  )
}

const foldersSchema = sharedFoldersSchema(32)
const sandboxFolderFields = { folders: foldersSchema, writableFolders: foldersSchema.optional() }

function writableFoldersAreShared(value: { folders: ComputerFolder[]; writableFolders?: ComputerFolder[] }): boolean {
  return value.writableFolders?.every((folder) => value.folders.includes(folder)) ?? true
}
const writableFoldersCheck = { path: ["writableFolders"], message: "Writable folders must also be shared folders." }

export const computerSandboxScopeSchema = z.strictObject({
  surface: z.literal("sandbox"),
  ...sandboxFolderFields,
}).refine(writableFoldersAreShared, writableFoldersCheck)
export type ComputerSandboxScope = z.infer<typeof computerSandboxScopeSchema>
const workingFolderSchema = z.array(computerFolderSchema).length(1)
export const computerWholeVmScopeSchema = z.strictObject({
  surface: z.literal("whole_vm"),
  folders: workingFolderSchema,
})
export const computerGrantScopeSchema = z.discriminatedUnion("surface", [computerSandboxScopeSchema, computerWholeVmScopeSchema])
export type ComputerWholeVmScope = z.infer<typeof computerWholeVmScopeSchema>
export type ComputerGrantScope = z.infer<typeof computerGrantScopeSchema>

export const computerSourceRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("workbot") }),
  z.strictObject({ kind: z.literal("computer"), id: z.string() }),
  z.strictObject({ kind: z.literal("owner") }),
])
export type ComputerSourceRef = z.infer<typeof computerSourceRefSchema>

export const computerGrantSchema = z.object({
  source: computerSourceRefSchema,
  targetId: z.string(),
  scope: computerGrantScopeSchema,
}).meta({ ref: "ComputerGrant" })
export type ComputerGrant = z.infer<typeof computerGrantSchema>

export const computerActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("shell"),
    command: z.string().min(1).max(32_000),
    cwd: computerFolderSchema.optional(),
    timeoutMs: z.number().int().min(1).max(120_000).optional(),
  }),
  z.object({ type: z.literal("read"), path: computerFolderSchema }),
  z.object({ type: z.literal("write"), path: computerFolderSchema }),
  z.object({ type: z.literal("list"), path: computerFolderSchema.optional() }),
  z.object({ type: z.literal("search"), path: computerFolderSchema.optional() }),
]).meta({ ref: "ComputerAction" })
export type ComputerAction = z.infer<typeof computerActionSchema>

export const COMPUTER_TOOL_NAMES = ["shell", "read", "write", "edit", "glob", "grep"] as const
export type ComputerToolName = (typeof COMPUTER_TOOL_NAMES)[number]
export const COMPUTER_TOOL_CALL_MAX_BYTES = 128_000
const utf8 = new TextEncoder()
const toolTextSchema = z.string().min(1).max(32_000)
const toolContentSchema = z.string().max(32_000)
const toolLimitSchema = z.number().int().min(1).max(2_000).optional()
const toolCallSchema = z.discriminatedUnion("tool", [
  z.strictObject({ tool: z.literal("shell"), input: z.strictObject({
    command: toolTextSchema,
    cwd: computerFolderSchema,
    timeoutMs: z.number().int().min(1).max(120_000).optional(),
  }) }),
  z.strictObject({ tool: z.literal("read"), input: z.strictObject({
    path: computerFolderSchema,
    offset: z.number().int().min(1).optional(),
    limit: toolLimitSchema,
  }) }),
  z.strictObject({ tool: z.literal("write"), input: z.strictObject({ path: computerFolderSchema, content: toolContentSchema }) }),
  z.strictObject({ tool: z.literal("edit"), input: z.strictObject({
    path: computerFolderSchema,
    oldString: toolTextSchema,
    newString: toolContentSchema,
    replaceAll: z.boolean().optional(),
  }) }),
  z.strictObject({ tool: z.literal("glob"), input: z.strictObject({
    path: computerFolderSchema,
    pattern: toolTextSchema,
    hidden: z.boolean().optional(),
    limit: toolLimitSchema,
  }) }),
  z.strictObject({ tool: z.literal("grep"), input: z.strictObject({
    path: computerFolderSchema,
    pattern: toolTextSchema,
    literal: z.boolean().optional(),
    include: z.string().max(1_024).optional(),
    caseSensitive: z.boolean().optional(),
    limit: toolLimitSchema,
  }) }),
])
export type ComputerToolCall = z.infer<typeof toolCallSchema>

/** Measure the call as UTF-8 JSON, including keys and escaped characters. */
export function computerToolCallFits(call: ComputerToolCall): boolean {
  return utf8.encode(JSON.stringify(call)).byteLength <= COMPUTER_TOOL_CALL_MAX_BYTES
}

export const computerToolCallSchema = toolCallSchema.refine(
  computerToolCallFits, `Tool calls must be at most ${COMPUTER_TOOL_CALL_MAX_BYTES} bytes.`,
).meta({ ref: "ComputerToolCall" })

export const COMPUTER_DECISION_LAYERS = ["organization", "computer", "source"] as const
export type ComputerDecisionLayer = (typeof COMPUTER_DECISION_LAYERS)[number]
export const COMPUTER_REFUSAL_CODES = [
  "organization_off", "computer_not_allowed", "not_available_yet", "owner_app_only", "nothing_shared", "folder_not_shared",
  "sandbox_unavailable", "source_not_allowed", "folder_read_only", "not_owner",
] as const
export type ComputerRefusalCode = (typeof COMPUTER_REFUSAL_CODES)[number]
export const COMPUTER_CHANGEABLE_BY = ["organization_admin", "computer_owner", "no_one"] as const
export type ComputerChangeableBy = (typeof COMPUTER_CHANGEABLE_BY)[number]

const refusalFields = {
  layer: z.enum(COMPUTER_DECISION_LAYERS),
  code: z.enum(COMPUTER_REFUSAL_CODES),
  message: z.string(),
  changeableBy: z.enum(COMPUTER_CHANGEABLE_BY),
}

export const computerRefusalSchema = z.object({ outcome: z.literal("refuse"), ...refusalFields })
export type ComputerRefusal = z.infer<typeof computerRefusalSchema>

export const computerAllowanceSchema = z.discriminatedUnion("route", [
  z.object({ outcome: z.literal("allow"), route: z.literal("direct"), scope: z.null() }),
  z.object({ outcome: z.literal("allow"), route: z.literal("checked"), scope: computerGrantScopeSchema }),
])
export type ComputerAllowance = z.infer<typeof computerAllowanceSchema>

export const computerDecisionSchema = z.discriminatedUnion("outcome", [
  computerAllowanceSchema,
  computerRefusalSchema,
]).meta({ ref: "ComputerDecision" })
export type ComputerDecision = z.infer<typeof computerDecisionSchema>

export const COMPUTER_OWNER_CHOICES = ["allow", "off"] as const
export type ComputerOwnerChoice = (typeof COMPUTER_OWNER_CHOICES)[number]
const ownerChoiceSchema = z.enum(COMPUTER_OWNER_CHOICES).nullable()

export const computerPolicySchema = z.object({
  organization: z.object({ allowed: z.boolean(), requireSandboxOnPersonal: z.boolean() }),
  owner: z.object({ choice: ownerChoiceSchema }),
  grants: z.array(computerGrantSchema),
})
export type ComputerPolicy = z.infer<typeof computerPolicySchema>

const computerStateSchema = z.enum(["ready", "starts_when_needed", "has_a_problem", "online", "offline"])
export const COMPUTER_STATES = Object.freeze(computerStateSchema.options)
export type ComputerState = z.infer<typeof computerStateSchema>
export const COMPUTER_STATE_LABELS = Object.freeze({
  ready: "Ready",
  starts_when_needed: "Starts when needed",
  has_a_problem: "Has a problem",
  online: "Online",
  offline: "Offline",
} satisfies Record<ComputerState, string>)

export const computerAccessSettingSchema = z.discriminatedUnion("choice", [
  z.strictObject({ choice: z.literal("allow"), scope: z.literal("whole_vm"), folders: workingFolderSchema }),
  z.strictObject({ choice: z.literal("off"), folders: sharedFoldersSchema(8).optional() }),
])
export type ComputerAccessSetting = z.infer<typeof computerAccessSettingSchema>

export const listedComputerSchema = computerSchema.extend({
  state: computerStateSchema,
  lastSeenAt: z.iso.datetime({ offset: true }).nullable(),
  access: z.object({ choice: ownerChoiceSchema, scope: z.literal("whole_vm").optional(), folders: z.array(z.string()) }).nullable(),
  reach: computerDecisionSchema,
}).meta({ ref: "ListedComputer" })
export type ListedComputer = z.infer<typeof listedComputerSchema>

export const computerListResponseSchema = z.object({ computers: z.array(listedComputerSchema) })
export type ComputerListResponse = z.infer<typeof computerListResponseSchema>

export const computerSourceListResponseSchema = z.object({
  self: computerSchema.nullable(),
  computers: z.array(listedComputerSchema),
}).meta({ ref: "ComputerSourceListResponse" })
export type ComputerSourceListResponse = z.infer<typeof computerSourceListResponseSchema>

export const computerAuthorizeRequestSchema = z.strictObject({ action: computerActionSchema })
export type ComputerAuthorizeRequest = z.infer<typeof computerAuthorizeRequestSchema>

export const computerAuthorizeResponseSchema = z.object({
  decision: computerDecisionSchema,
  computer: listedComputerSchema,
  connection: z.object({ provider: z.enum(REMOTE_DEVICE_PROVIDERS), externalId: z.string() }).nullable(),
})
export type ComputerAuthorizeResponse = z.infer<typeof computerAuthorizeResponseSchema>

export const COMPUTER_COMMAND_STATUSES = ["pending", "claimed", "done", "failed", "refused", "expired"] as const
export type ComputerCommandStatus = (typeof COMPUTER_COMMAND_STATUSES)[number]
export const COMPUTER_OUTPUT_MAX_BYTES = 32_000
export const COMPUTER_COMMAND_PICKUP_MS = 30_000
export const COMPUTER_COMMAND_RETENTION_MS = 15 * 60_000

const expiresAtSchema = z.iso.datetime({ offset: true })
const executionErrorSchema = z.object({ code: z.string(), message: z.string() })
const doneFields = { exitCode: z.number().int(), output: z.string(), truncated: z.boolean() }

export const computerExecutionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("refused"), ...refusalFields }),
  z.object({ state: z.literal("offline"), message: z.string(), retryable: z.literal(true), lastSeenAt: z.iso.datetime({ offset: true }).nullable().default(null) }),
  z.object({ state: z.literal("unsupported"), message: z.string() }),
  z.object({ state: z.literal("running"), id: z.string(), expiresAt: expiresAtSchema }),
  z.object({ state: z.literal("unknown"), id: z.string(), message: z.string() }),
  z.object({ state: z.literal("done"), id: z.string(), ...doneFields }),
  z.object({ state: z.literal("failed"), id: z.string(), error: executionErrorSchema }),
]).meta({ ref: "ComputerExecution" })
export type ComputerExecution = z.infer<typeof computerExecutionSchema>

export { COMPUTER_SHELL_RUNNER_CAPABILITY } from "@openwork/types/automations"
export const COMPUTER_OWNER_WHOLE_VM_SOURCE_KEY = "owner_whole_vm"
const computerRunnerSourceSchema = computerSourceRefSchema.refine(
  (source) => source.kind !== "computer" || source.id !== COMPUTER_OWNER_WHOLE_VM_SOURCE_KEY,
  "This source is reserved for a registered virtual computer's owner.",
)
export const computerAccessReportSchema = z.strictObject({
  choice: ownerChoiceSchema,
  grants: z.array(z.strictObject({ source: computerRunnerSourceSchema, ...sandboxFolderFields })
    .refine(writableFoldersAreShared, writableFoldersCheck)).max(16),
})
export type ComputerAccessReport = z.infer<typeof computerAccessReportSchema>

export const computerRunnerAccessResponseSchema = z.object({
  organizationAllows: z.boolean(),
  choice: ownerChoiceSchema,
  grants: z.array(z.object({
    source: computerSourceRefSchema,
    folders: z.array(z.string()),
    writableFolders: z.array(z.string()),
    revokedAt: z.string().nullable(),
  })),
}).meta({ ref: "ComputerRunnerAccessResponse" })
export type ComputerRunnerAccessResponse = z.infer<typeof computerRunnerAccessResponseSchema>

export const computerSourceCommandRequestSchema = z.strictObject({
  call: computerToolCallSchema,
  waitMs: z.number().int().min(0).max(20_000).default(15_000),
}).meta({ ref: "ComputerSourceCommandRequest" })
export type ComputerSourceCommandRequest = z.infer<typeof computerSourceCommandRequestSchema>

export const computerCommandListResponseSchema = z.object({
  items: z.array(z.object({ id: z.string(), expiresAt: expiresAtSchema })),
})
export type ComputerCommandListResponse = z.infer<typeof computerCommandListResponseSchema>

/** A runner advertising computer_shell_v1 must run each assignment inside its
 * sandbox with only the assignment's scope.folders mounted from the host,
 * read-only unless listed in scope.writableFolders.
 * Den's check of the requested path is an early refusal, not a sandbox boundary.
 */
export const computerCommandAssignmentSchema = z.object({
  id: z.string(),
  source: computerSchema,
  action: computerActionSchema,
  call: computerToolCallSchema.optional(),
  scope: computerSandboxScopeSchema,
  expiresAt: expiresAtSchema,
})
export type ComputerCommandAssignment = z.infer<typeof computerCommandAssignmentSchema>

export const computerCommandClaimResponseSchema = z.object({ assignment: computerCommandAssignmentSchema })
export type ComputerCommandClaimResponse = z.infer<typeof computerCommandClaimResponseSchema>

export const computerCommandCompleteRequestSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("done"),
    ...doneFields,
    output: z.string().max(COMPUTER_OUTPUT_MAX_BYTES).refine(
      (output) => utf8.encode(output).byteLength <= COMPUTER_OUTPUT_MAX_BYTES,
      `Output must be at most ${COMPUTER_OUTPUT_MAX_BYTES} bytes.`,
    ),
  }),
  z.object({
    status: z.literal("failed"),
    error: z.object({
      code: z.string().max(64).regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/),
      message: z.string().max(300),
    }),
  }),
  z.object({ status: z.literal("refused"), layer: refusalFields.layer, code: refusalFields.code }),
])
export type ComputerCommandCompleteRequest = z.infer<typeof computerCommandCompleteRequestSchema>

export const computerCommandCompleteResponseSchema = z.object({
  command: z.object({ id: z.string(), status: z.enum(COMPUTER_COMMAND_STATUSES) }),
})
export type ComputerCommandCompleteResponse = z.infer<typeof computerCommandCompleteResponseSchema>
