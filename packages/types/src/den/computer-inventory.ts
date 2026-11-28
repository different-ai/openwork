import { z } from "zod"
import { remoteSessionAccessModeSchema } from "@openwork/types/automations"
import { remoteDeviceAccessSchema, remoteDeviceEventSchema } from "@openwork/types/den/remote-devices"

/**
 * Computer inventory: what the two Den pages (My Computers and Manage >
 * Computers) show when `computers` is on. One row per physical machine, one
 * Workbot computer per person, and a status that only says whether OpenWork is
 * installed and reachable there.
 *
 * A row is a projection over `remote_device` rows. Several sign-ins of the same
 * machine fold into one row; the newest sign-in is the row and the others are
 * counted in `mergedSignIns`. Nothing here grants access.
 */

const timestampSchema = z.string().datetime({ offset: true })

/** What a row is. `instance` is an OpenWork worker instance; it only appears on the admin Cloud tab. */
export const COMPUTER_INVENTORY_KINDS = ["desktop", "cloud", "workbot", "instance"] as const
export type ComputerInventoryKind = (typeof COMPUTER_INVENTORY_KINDS)[number]

/** Is OpenWork installed and reachable. Desktops are online or offline; cloud machines are never "offline". */
export const COMPUTER_INVENTORY_STATES = ["online", "offline", "ready", "starts_when_needed", "has_a_problem"] as const
export type ComputerInventoryState = (typeof COMPUTER_INVENTORY_STATES)[number]
export const COMPUTER_INVENTORY_STATE_LABELS: Record<ComputerInventoryState, string> = {
  online: "Online",
  offline: "Offline",
  ready: "Ready",
  starts_when_needed: "Starts when needed",
  has_a_problem: "Has a problem",
}

/**
 * Run code here: can an agent on another computer run commands and edit files
 * on this one?
 *
 * - `no`: it could, and the owner or the organization has it off (`reason`).
 * - `not_available`: this computer cannot take work from another computer yet.
 * - `sandbox`: yes, inside its sandbox, with `folders` shared folders mounted.
 *   Only reported for a computer whose OpenWork enforces folders as mounts.
 * - `whole_computer`: yes, everything on it. Cloud machines only.
 */
export const COMPUTER_RUN_CODE_OFF_REASONS = ["organization", "owner", "not_chosen"] as const
export type ComputerRunCodeOffReason = (typeof COMPUTER_RUN_CODE_OFF_REASONS)[number]
export const computerRunCodeSchema = z.discriminatedUnion("value", [
  z.object({ value: z.literal("no"), reason: z.enum(COMPUTER_RUN_CODE_OFF_REASONS) }),
  z.object({ value: z.literal("not_available") }),
  z.object({ value: z.literal("sandbox"), folders: z.number().int().nonnegative() }),
  z.object({ value: z.literal("whole_computer") }),
]).meta({ ref: "ComputerRunCode" })
export type ComputerRunCode = z.infer<typeof computerRunCodeSchema>

/** Read its sessions: which sessions on this computer other devices may open. */
export const COMPUTER_READ_SESSIONS = ["none", "started_by_them", "all"] as const
export type ComputerReadSessions = (typeof COMPUTER_READ_SESSIONS)[number]
export const COMPUTER_READ_SESSIONS_LABELS: Record<ComputerReadSessions, string> = {
  none: "None",
  started_by_them: "Only ones it started",
  all: "All sessions",
}

/**
 * Send it tasks and Read its sessions are two views of the one remote-tasks
 * setting (`off`, `created`, `all`): `off` is Off and None, `created` is On and
 * Only ones it started, `all` is On and All sessions.
 */
export const computerSessionsSchema = z.object({
  sendTasks: z.boolean(),
  readSessions: z.enum(COMPUTER_READ_SESSIONS),
  /** The underlying setting with why it is narrower than chosen; null where the computer has no such setting. */
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

/** A problem in another feature. It never changes `status`. */
export const COMPUTER_INVENTORY_NOTE_CODES = ["computer_use_permissions", "disconnected", "update_required", "provider_problem"] as const
export const computerInventoryNoteSchema = z.object({
  code: z.enum(COMPUTER_INVENTORY_NOTE_CODES),
  /** One short sentence for the row, in product words. */
  message: z.string(),
})
export type ComputerInventoryNote = z.infer<typeof computerInventoryNoteSchema>

export const computerInventoryRowSchema = z.object({
  /** The newest sign-in's `remote_device` id, or the worker id for an `instance`. */
  id: z.string(),
  kind: z.enum(COMPUTER_INVENTORY_KINDS),
  /** "Mac", "Windows PC", "Linux PC", "Daytona computer", "Workbot's computer", "OpenWork instance"… */
  kindLabel: z.string(),
  label: z.string(),
  /** Null for a computer shared with the organization. */
  owner: computerInventoryOwnerSchema.nullable(),
  shared: z.boolean(),
  status: z.object({
    state: z.enum(COMPUTER_INVENTORY_STATES),
    lastSeenAt: timestampSchema.nullable(),
  }),
  notes: z.array(computerInventoryNoteSchema),
  runCode: computerRunCodeSchema,
  sessions: computerSessionsSchema,
  /** Older sign-ins of this same machine folded into this row. */
  mergedSignIns: z.number().int().nonnegative(),
  canRename: z.boolean(),
  canDisconnect: z.boolean(),
  canRemove: z.boolean(),
}).meta({ ref: "ComputerInventoryRow" })
export type ComputerInventoryRow = z.infer<typeof computerInventoryRowSchema>

/** An older sign-in of a machine that has a row. Shown behind "Show". */
export const computerMergedSignInSchema = z.object({
  id: z.string(),
  /** The row it is folded into. */
  computerId: z.string(),
  label: z.string(),
  appVersion: z.string().nullable(),
  addedAt: timestampSchema,
  lastSeenAt: timestampSchema.nullable(),
  canRemove: z.boolean(),
}).meta({ ref: "ComputerMergedSignIn" })
export type ComputerMergedSignIn = z.infer<typeof computerMergedSignInSchema>

/** `GET /v1/computers/inventory`: the caller's own computers and the ones shared with the organization. */
export const myComputerInventoryResponseSchema = z.object({
  computers: z.array(computerInventoryRowSchema),
  mergedSignIns: z.array(computerMergedSignInSchema),
}).meta({ ref: "MyComputerInventoryResponse" })
export type MyComputerInventoryResponse = z.infer<typeof myComputerInventoryResponseSchema>

export const ORGANIZATION_COMPUTER_INVENTORY_TABS = ["desktops", "cloud", "attention", "former"] as const
export type OrganizationComputerInventoryTab = (typeof ORGANIZATION_COMPUTER_INVENTORY_TABS)[number]
/** The default view leaves out machines nobody has heard from for this long; they sit behind "Show older". */
export const COMPUTER_INVENTORY_RECENT_MS = 7 * 24 * 60 * 60_000
export const COMPUTER_INVENTORY_PAGE_SIZE = 50

/** What the organization allows. Edited in organization settings, summarized on the Computers page. */
export const organizationComputerRulesSchema = z.object({
  /** The remote-tasks ceiling: the most an owner may choose for Send it tasks and Read its sessions. */
  sessions: remoteSessionAccessModeSchema,
  /** May an agent on another computer run code on a member's computer at all. */
  runCode: z.boolean(),
  /** Work arriving on a personal computer must run in that computer's sandbox. */
  requireSandboxOnPersonal: z.boolean(),
}).meta({ ref: "OrganizationComputerRules" })
export type OrganizationComputerRules = z.infer<typeof organizationComputerRulesSchema>

/** `GET /v1/org/computers/inventory?tab=&search=&older=include&page=` */
export const organizationComputerInventoryResponseSchema = z.object({
  tab: z.enum(ORGANIZATION_COMPUTER_INVENTORY_TABS),
  computers: z.array(computerInventoryRowSchema),
  mergedSignIns: z.array(computerMergedSignInSchema),
  /** Per tab, with the current search applied and older machines included. */
  counts: z.object({
    desktops: z.number().int().nonnegative(),
    cloud: z.number().int().nonnegative(),
    attention: z.number().int().nonnegative(),
    former: z.number().int().nonnegative(),
  }),
  /** Machines in this tab not heard from in the last week, left out unless `older=include`. */
  olderHidden: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  rules: organizationComputerRulesSchema,
}).meta({ ref: "OrganizationComputerInventoryResponse" })
export type OrganizationComputerInventoryResponse = z.infer<typeof organizationComputerInventoryResponseSchema>

/** Who may run code on a computer: one entry per source the owner allowed. */
export const computerSourceAccessSchema = z.object({
  /** Stable key for revoke: "workbot", "owner", "owner_whole_vm" or a computer id. */
  key: z.string(),
  /** "Workbot", "Maya's OpenWork apps", or the source computer's name. */
  label: z.string(),
  scope: z.enum(["sandbox", "whole_computer"]),
  /** Shared folders for `sandbox`; the one working folder for `whole_computer`. */
  folders: z.array(z.string()),
  revokedAt: timestampSchema.nullable(),
  revokedBy: z.string().nullable(),
}).meta({ ref: "ComputerSourceAccess" })
export type ComputerSourceAccess = z.infer<typeof computerSourceAccessSchema>

/**
 * `GET /v1/computers/inventory/:computerId` for the owner and
 * `GET /v1/org/computers/inventory/:computerId` for an admin. The three cards
 * of the row detail: Installed, Run code here, Sessions.
 */
export const computerInventoryDetailResponseSchema = z.object({
  computer: computerInventoryRowSchema,
  installed: z.object({
    appVersion: z.string().nullable(),
    /** "macOS", "Windows", "Linux"; null when the computer never said. */
    platform: z.string().nullable(),
    signedInAs: z.object({ name: z.string().nullable(), email: z.string().nullable() }).nullable(),
    addedAt: timestampSchema,
    lastSeenAt: timestampSchema.nullable(),
    mergedSignIns: z.array(computerMergedSignInSchema),
  }),
  runCode: z.object({
    value: computerRunCodeSchema,
    sources: z.array(computerSourceAccessSchema),
    /** The caller may turn whole-computer access on or off here (own registered cloud computer). */
    canChange: z.boolean(),
    /** The caller may revoke a source: the owner, or an admin who may disconnect computers. */
    canRevoke: z.boolean(),
    /** The caller may allow a revoked source again: the owner only. */
    canRestore: z.boolean(),
  }),
  sessions: computerSessionsSchema,
  rules: organizationComputerRulesSchema,
  /** False for an admin looking at someone else's computer: "Only <owner> can change these". */
  callerIsOwner: z.boolean(),
  activity: z.array(remoteDeviceEventSchema),
}).meta({ ref: "ComputerInventoryDetailResponse" })
export type ComputerInventoryDetailResponse = z.infer<typeof computerInventoryDetailResponseSchema>

/** `GET` and `PATCH /v1/org/computer-rules`. */
export const organizationComputerRulesResponseSchema = z.object({
  rules: organizationComputerRulesSchema,
  /** False until an admin has chosen `runCode`; it then follows the remote-tasks setting (off there means off here). */
  runCodeChosen: z.boolean(),
}).meta({ ref: "OrganizationComputerRulesResponse" })
export type OrganizationComputerRulesResponse = z.infer<typeof organizationComputerRulesResponseSchema>

export const organizationComputerRulesUpdateSchema = z.strictObject({
  runCode: z.boolean().optional(),
  requireSandboxOnPersonal: z.boolean().optional(),
}).refine((value) => value.runCode !== undefined || value.requireSandboxOnPersonal !== undefined, "Change at least one rule.")
  .meta({ ref: "UpdateOrganizationComputerRulesRequest" })
export type OrganizationComputerRulesUpdate = z.infer<typeof organizationComputerRulesUpdateSchema>

/** Organization metadata key holding the two computer rules. */
export const ORGANIZATION_COMPUTER_RULES_KEY = "computers"
