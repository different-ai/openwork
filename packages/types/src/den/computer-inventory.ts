import { z } from "zod"
import { remoteSessionAccessModeSchema } from "@openwork/types/automations"
import { readOrganizationMetadata } from "@openwork/types/den/managed-models-policy"
import { remoteDeviceAccessSchema, remoteDeviceEventSchema } from "@openwork/types/den/remote-devices"
import { readOrganizationRemoteSessionSettings } from "@openwork/types/den/remote-sessions"

const timestampSchema = z.string().datetime({ offset: true })

export const COMPUTER_INVENTORY_KINDS = ["desktop", "cloud", "workbot", "instance"] as const
export type ComputerInventoryKind = (typeof COMPUTER_INVENTORY_KINDS)[number]

export const COMPUTER_INVENTORY_STATES = ["online", "offline", "ready", "starts_when_needed", "has_a_problem"] as const
export type ComputerInventoryState = (typeof COMPUTER_INVENTORY_STATES)[number]
export const COMPUTER_INVENTORY_STATE_LABELS: Record<ComputerInventoryState, string> = {
  online: "Online",
  offline: "Offline",
  ready: "Ready",
  starts_when_needed: "Starts when needed",
  has_a_problem: "Has a problem",
}

export const COMPUTER_RUN_CODE_OFF_REASONS = ["organization", "owner", "not_chosen"] as const
export type ComputerRunCodeOffReason = (typeof COMPUTER_RUN_CODE_OFF_REASONS)[number]
export const computerRunCodeSchema = z.discriminatedUnion("value", [
  z.object({ value: z.literal("no"), reason: z.enum(COMPUTER_RUN_CODE_OFF_REASONS) }),
  z.object({ value: z.literal("not_available") }),
  z.object({ value: z.literal("sandbox"), folders: z.number().int().nonnegative() }),
  z.object({ value: z.literal("whole_computer") }),
]).meta({ ref: "ComputerRunCode" })
export type ComputerRunCode = z.infer<typeof computerRunCodeSchema>

export const COMPUTER_READ_SESSIONS = ["none", "started_by_them", "all"] as const
export type ComputerReadSessions = (typeof COMPUTER_READ_SESSIONS)[number]
export const COMPUTER_READ_SESSIONS_LABELS: Record<ComputerReadSessions, string> = {
  none: "None",
  started_by_them: "Only ones it started",
  all: "All sessions",
}

export const computerSessionsSchema = z.object({
  sendTasks: z.boolean(),
  readSessions: z.enum(COMPUTER_READ_SESSIONS),
  access: remoteDeviceAccessSchema.nullable(),
}).meta({ ref: "ComputerSessions" })
export type ComputerSessions = z.infer<typeof computerSessionsSchema>

export const computerInventoryOwnerSchema = z.object({
  memberId: z.string().nullable(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  former: z.boolean(),
})
export type ComputerInventoryOwner = z.infer<typeof computerInventoryOwnerSchema>

export const COMPUTER_INVENTORY_NOTE_CODES = ["computer_use_permissions", "disconnected", "update_required", "provider_problem"] as const
export const computerInventoryNoteSchema = z.object({
  code: z.enum(COMPUTER_INVENTORY_NOTE_CODES),
  message: z.string(),
})
export type ComputerInventoryNote = z.infer<typeof computerInventoryNoteSchema>

export const computerInventoryRowSchema = z.object({
  id: z.string(),
  kind: z.enum(COMPUTER_INVENTORY_KINDS),
  kindLabel: z.string(),
  label: z.string(),
  owner: computerInventoryOwnerSchema.nullable(),
  shared: z.boolean(),
  status: z.object({
    state: z.enum(COMPUTER_INVENTORY_STATES),
    lastSeenAt: timestampSchema.nullable(),
  }),
  notes: z.array(computerInventoryNoteSchema),
  runCode: computerRunCodeSchema,
  sessions: computerSessionsSchema,
  mergedSignIns: z.number().int().nonnegative(),
  canRename: z.boolean(),
  canDisconnect: z.boolean(),
  canRemove: z.boolean(),
}).meta({ ref: "ComputerInventoryRow" })
export type ComputerInventoryRow = z.infer<typeof computerInventoryRowSchema>

export const computerMergedSignInSchema = z.object({
  id: z.string(),
  computerId: z.string(),
  label: z.string(),
  appVersion: z.string().nullable(),
  addedAt: timestampSchema,
  lastSeenAt: timestampSchema.nullable(),
  canRemove: z.boolean(),
}).meta({ ref: "ComputerMergedSignIn" })
export type ComputerMergedSignIn = z.infer<typeof computerMergedSignInSchema>

export const myComputerInventoryResponseSchema = z.object({
  computers: z.array(computerInventoryRowSchema),
  mergedSignIns: z.array(computerMergedSignInSchema),
}).meta({ ref: "MyComputerInventoryResponse" })
export type MyComputerInventoryResponse = z.infer<typeof myComputerInventoryResponseSchema>

export const ORGANIZATION_COMPUTER_INVENTORY_TABS = ["desktops", "cloud", "attention", "former"] as const
export type OrganizationComputerInventoryTab = (typeof ORGANIZATION_COMPUTER_INVENTORY_TABS)[number]
export const COMPUTER_INVENTORY_RECENT_MS = 7 * 24 * 60 * 60_000
export const COMPUTER_INVENTORY_PAGE_SIZE = 50

export const organizationComputerRulesSchema = z.object({
  sessions: remoteSessionAccessModeSchema,
  runCode: z.boolean(),
  requireSandboxOnPersonal: z.boolean(),
}).meta({ ref: "OrganizationComputerRules" })
export type OrganizationComputerRules = z.infer<typeof organizationComputerRulesSchema>

export const organizationComputerInventoryResponseSchema = z.object({
  tab: z.enum(ORGANIZATION_COMPUTER_INVENTORY_TABS),
  computers: z.array(computerInventoryRowSchema),
  mergedSignIns: z.array(computerMergedSignInSchema),
  counts: z.object({
    desktops: z.number().int().nonnegative(),
    cloud: z.number().int().nonnegative(),
    attention: z.number().int().nonnegative(),
    former: z.number().int().nonnegative(),
  }),
  olderHidden: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  rules: organizationComputerRulesSchema,
}).meta({ ref: "OrganizationComputerInventoryResponse" })
export type OrganizationComputerInventoryResponse = z.infer<typeof organizationComputerInventoryResponseSchema>

export const computerSourceAccessSchema = z.object({
  key: z.string(),
  label: z.string(),
  scope: z.enum(["sandbox", "whole_computer"]),
  folders: z.array(z.string()),
  revokedAt: timestampSchema.nullable(),
  revokedBy: z.string().nullable().describe("The name of the member who revoked access, or their email if no name is available."),
}).meta({ ref: "ComputerSourceAccess" })
export type ComputerSourceAccess = z.infer<typeof computerSourceAccessSchema>

export const computerInventoryDetailResponseSchema = z.object({
  computer: computerInventoryRowSchema,
  installed: z.object({
    appVersion: z.string().nullable(),
    platform: z.string().nullable(),
    signedInAs: z.object({ name: z.string().nullable(), email: z.string().nullable() }).nullable(),
    addedAt: timestampSchema,
    lastSeenAt: timestampSchema.nullable(),
    mergedSignIns: z.array(computerMergedSignInSchema),
  }),
  runCode: z.object({
    value: computerRunCodeSchema,
    sources: z.array(computerSourceAccessSchema),
    canChange: z.boolean(),
    canRevoke: z.boolean(),
    canRestore: z.boolean(),
  }),
  sessions: computerSessionsSchema,
  rules: organizationComputerRulesSchema,
  callerIsOwner: z.boolean(),
  activity: z.array(remoteDeviceEventSchema),
}).meta({ ref: "ComputerInventoryDetailResponse" })
export type ComputerInventoryDetailResponse = z.infer<typeof computerInventoryDetailResponseSchema>

export const organizationComputerRulesResponseSchema = z.object({
  rules: organizationComputerRulesSchema,
  runCodeChosen: z.boolean(),
}).meta({ ref: "OrganizationComputerRulesResponse" })
export type OrganizationComputerRulesResponse = z.infer<typeof organizationComputerRulesResponseSchema>

export const organizationComputerRulesUpdateSchema = z.strictObject({
  runCode: z.boolean().optional(),
  requireSandboxOnPersonal: z.boolean().optional(),
}).refine((value) => value.runCode !== undefined || value.requireSandboxOnPersonal !== undefined, "Change at least one rule.")
  .meta({ ref: "UpdateOrganizationComputerRulesRequest" })
export type OrganizationComputerRulesUpdate = z.infer<typeof organizationComputerRulesUpdateSchema>

export const ORGANIZATION_COMPUTER_RULES_KEY = "computers"

export function readOrganizationComputerRules(metadata: unknown): OrganizationComputerRulesResponse {
  const sessions = readOrganizationRemoteSessionSettings(metadata).access
  let stored: unknown
  try {
    stored = readOrganizationMetadata(metadata)[ORGANIZATION_COMPUTER_RULES_KEY]
  } catch {
    stored = null
  }
  const fields = z.object({ runCode: z.unknown(), requireSandboxOnPersonal: z.unknown() }).partial().safeParse(stored).data
  const runCode = typeof fields?.runCode === "boolean" ? fields.runCode : undefined
  const requireSandboxOnPersonal = typeof fields?.requireSandboxOnPersonal === "boolean" ? fields.requireSandboxOnPersonal : true
  return { rules: { sessions, runCode: runCode ?? (sessions !== "off"), requireSandboxOnPersonal }, runCodeChosen: runCode !== undefined }
}
