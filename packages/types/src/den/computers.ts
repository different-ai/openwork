import { z } from "zod"
import { REMOTE_DEVICE_AVAILABILITIES, REMOTE_DEVICE_PROVIDERS } from "@openwork/types/den/remote-devices"

export const COMPUTER_KINDS = ["cloud_sandbox", "registered_vm", "member_machine"] as const
export type ComputerKind = (typeof COMPUTER_KINDS)[number]

export const COMPUTER_ROLES = ["source", "target"] as const
export type ComputerRole = (typeof COMPUTER_ROLES)[number]

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

const foldersSchema = z.array(computerFolderSchema).max(32).refine(
  (folders) => new Set(folders).size === folders.length,
  "List each shared folder only once.",
)

export const computerGrantScopeSchema = z.strictObject({
  surface: z.literal("sandbox"),
  folders: foldersSchema,
})
export type ComputerGrantScope = z.infer<typeof computerGrantScopeSchema>

export const computerSourceRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("workbot") }),
  z.strictObject({ kind: z.literal("computer"), id: z.string() }),
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
]).meta({ ref: "ComputerAction" })
export type ComputerAction = z.infer<typeof computerActionSchema>

export const COMPUTER_DECISION_LAYERS = ["organization", "computer", "source"] as const
export type ComputerDecisionLayer = (typeof COMPUTER_DECISION_LAYERS)[number]
export const COMPUTER_REFUSAL_CODES = ["organization_off", "computer_not_allowed", "nothing_shared", "folder_not_shared"] as const
export type ComputerRefusalCode = (typeof COMPUTER_REFUSAL_CODES)[number]
export const COMPUTER_CHANGEABLE_BY = ["organization_admin", "computer_owner"] as const
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
  organization: z.object({ allowed: z.boolean() }),
  owner: z.object({ choice: ownerChoiceSchema }),
  grants: z.array(computerGrantSchema),
})
export type ComputerPolicy = z.infer<typeof computerPolicySchema>

export const COMPUTER_COMMAND_STATUSES = ["pending", "claimed", "done", "failed", "refused", "expired"] as const
export type ComputerCommandStatus = (typeof COMPUTER_COMMAND_STATUSES)[number]
export const COMPUTER_OUTPUT_MAX_BYTES = 32_000

const expiresAtSchema = z.iso.datetime({ offset: true })
const executionErrorSchema = z.object({ code: z.string(), message: z.string() })
const doneFields = { exitCode: z.number().int(), output: z.string(), truncated: z.boolean() }

export const computerExecutionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("refused"), ...refusalFields }),
  z.object({ state: z.literal("offline"), message: z.string(), retryable: z.literal(true) }),
  z.object({ state: z.literal("unsupported"), message: z.string() }),
  z.object({ state: z.literal("running"), id: z.string(), expiresAt: expiresAtSchema }),
  z.object({ state: z.literal("done"), id: z.string(), ...doneFields }),
  z.object({ state: z.literal("failed"), id: z.string(), error: executionErrorSchema }),
]).meta({ ref: "ComputerExecution" })
export type ComputerExecution = z.infer<typeof computerExecutionSchema>

export { COMPUTER_SHELL_RUNNER_CAPABILITY } from "@openwork/types/automations"
export const computerAccessReportSchema = z.strictObject({
  choice: ownerChoiceSchema,
  grants: z.array(z.strictObject({ source: computerSourceRefSchema, folders: foldersSchema })).max(16),
})
export type ComputerAccessReport = z.infer<typeof computerAccessReportSchema>

export const computerCommandListResponseSchema = z.object({
  items: z.array(z.object({ id: z.string(), expiresAt: expiresAtSchema })),
})
export type ComputerCommandListResponse = z.infer<typeof computerCommandListResponseSchema>

export const computerCommandAssignmentSchema = z.object({
  id: z.string(),
  source: computerSchema,
  action: computerActionSchema,
  scope: computerGrantScopeSchema,
  expiresAt: expiresAtSchema,
})
export type ComputerCommandAssignment = z.infer<typeof computerCommandAssignmentSchema>

export const computerCommandClaimResponseSchema = z.object({ assignment: computerCommandAssignmentSchema })
export type ComputerCommandClaimResponse = z.infer<typeof computerCommandClaimResponseSchema>

const utf8 = new TextEncoder()
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
