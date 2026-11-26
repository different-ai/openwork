import { z } from "zod"

/**
 * Tool permissions: what a connection's tools may do for people and for the
 * things that run for them (chats, Automations, Workbot, agents).
 *
 * Each tool is Allow, Ask or Block. With no rule, a tool that only reads is
 * allowed and any other tool asks first. Rules can be set for the whole
 * organization, a team, a member or an agent, and every rule that applies to
 * a call is read together: a block wins, then ask, then allow. "Ask" refuses
 * the call and leaves an approval for the person it was made for; "Allow
 * once" covers the next run of the same agent or Automation, or the next call
 * from a chat.
 */
export const toolPermissionAccessSchema = z.enum(["allow", "ask", "block"]).meta({ ref: "ToolPermissionAccess" })
export type ToolPermissionAccess = z.infer<typeof toolPermissionAccessSchema>

export const TOOL_PERMISSION_EVERY_TOOL = "*"
export const TOOL_PERMISSION_WRITTEN_RULES_MAX_LENGTH = 4_000
export const TOOL_PERMISSION_RULES_MAX_PER_ORGANIZATION = 5_000

const idSchema = z.string().trim().min(1).max(160)
const timestampSchema = z.number().int().nonnegative()
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const toolNameSchema = z.string().min(1).max(128).refine((name) => !LONE_SURROGATE.test(name), "Expected well-formed text")

export const toolPermissionSubjectKindSchema = z.enum(["organization", "team", "member"]).meta({ ref: "ToolPermissionSubjectKind" })
export type ToolPermissionSubjectKind = z.infer<typeof toolPermissionSubjectKindSchema>

/** Who a rule is for. An agent's own rules are set in the agent's settings, not here. */
export const toolPermissionSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("organization") }).strict(),
  z.object({ kind: z.literal("team"), id: idSchema }).strict(),
  z.object({ kind: z.literal("member"), id: idSchema }).strict(),
]).meta({ ref: "ToolPermissionSubject" })
export type ToolPermissionSubject = z.infer<typeof toolPermissionSubjectSchema>

export const toolPermissionRuleSchema = z.object({
  id: idSchema,
  subject: z.object({
    kind: toolPermissionSubjectKindSchema,
    id: idSchema.nullable().describe("The team or member; null for the whole organization."),
    name: z.string().max(160).describe("The team's or person's name, or the organization's."),
  }),
  connectionId: idSchema,
  toolName: toolNameSchema.describe(`"${TOOL_PERMISSION_EVERY_TOOL}" for every tool of the connection, which can only be blocked.`),
  rule: toolPermissionAccessSchema,
  updatedAt: timestampSchema,
}).meta({ ref: "ToolPermissionRule" })
export type ToolPermissionRule = z.infer<typeof toolPermissionRuleSchema>

export const toolPermissionsSchema = z.object({
  rules: z.array(toolPermissionRuleSchema),
  writtenRules: z.string().max(TOOL_PERMISSION_WRITTEN_RULES_MAX_LENGTH)
    .describe("What the organization tells every run to follow first, in the admin's words."),
}).meta({ ref: "ToolPermissions" })
export type ToolPermissions = z.infer<typeof toolPermissionsSchema>

export const toolPermissionsQuerySchema = z.object({
  connectionId: idSchema.optional().describe("Only the rules of this connection."),
}).strict()

/** Set one rule, or remove it with `rule: null` so the default applies again. */
export const setToolPermissionRuleSchema = z.object({
  subject: toolPermissionSubjectSchema,
  connectionId: idSchema,
  toolName: toolNameSchema,
  rule: toolPermissionAccessSchema.nullable(),
}).strict().refine((input) => input.toolName !== TOOL_PERMISSION_EVERY_TOOL || input.rule === null || input.rule === "block",
  "A whole connection can only be blocked").meta({ ref: "SetToolPermissionRule" })
export type SetToolPermissionRule = z.infer<typeof setToolPermissionRuleSchema>

export const setToolPermissionWrittenRulesSchema = z.object({
  rules: z.string().max(TOOL_PERMISSION_WRITTEN_RULES_MAX_LENGTH),
}).strict().meta({ ref: "SetToolPermissionWrittenRules" })
export type SetToolPermissionWrittenRules = z.infer<typeof setToolPermissionWrittenRulesSchema>

export const toolApprovalContextKindSchema = z.enum(["agent", "automation", "chat"]).meta({ ref: "ToolApprovalContextKind" })
export type ToolApprovalContextKind = z.infer<typeof toolApprovalContextKindSchema>

export const toolApprovalStatusSchema = z.enum(["pending", "denied", "allowed_once", "always_allowed", "used"]).meta({ ref: "ToolApprovalStatus" })
export type ToolApprovalStatus = z.infer<typeof toolApprovalStatusSchema>

/** A tool call that waits for a yes from the person it was made for. Never tool arguments or results. */
export const toolApprovalSchema = z.object({
  id: idSchema,
  context: z.object({
    kind: toolApprovalContextKindSchema,
    id: idSchema.nullable().describe("The agent or Automation; null for a chat."),
    label: z.string().max(160).nullable().describe("The agent's or Automation's name when the call was refused."),
  }),
  runId: idSchema.nullable(),
  connectionId: idSchema,
  connectionName: z.string().max(160),
  toolName: z.string().max(128),
  toolTitle: z.string().max(240),
  status: toolApprovalStatusSchema,
  createdAt: timestampSchema,
}).meta({ ref: "ToolApproval" })
export type ToolApproval = z.infer<typeof toolApprovalSchema>

export const toolApprovalListSchema = z.object({
  items: z.array(toolApprovalSchema),
}).meta({ ref: "ToolApprovalList" })
export type ToolApprovalList = z.infer<typeof toolApprovalListSchema>

export const toolApprovalDecisionSchema = z.enum(["deny", "allow_once"]).meta({ ref: "ToolApprovalDecision" })
export type ToolApprovalDecision = z.infer<typeof toolApprovalDecisionSchema>

export const decideToolApprovalSchema = z.object({
  decision: toolApprovalDecisionSchema,
}).strict().meta({ ref: "DecideToolApproval" })
export type DecideToolApproval = z.infer<typeof decideToolApprovalSchema>
