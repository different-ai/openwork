import { z } from "zod"
import {
  automationDetailSchema,
  automationExecutionTargetSchema,
  automationModelSchema,
  automationRunSchema,
  automationRunStatusSchema,
  automationScheduleSchema,
  automationStateSchema,
} from "@openwork/types/automations"

const idSchema = z.string().trim().min(1).max(160)
const timestampSchema = z.string().datetime({ offset: true })

export const PERSONAL_AGENT_NAME_MAX_LENGTH = 120
export const PERSONAL_AGENT_BRIEF_MAX_LENGTH = 20_000
/** A run's prompt is the brief plus the routine's instructions, and has to fit the runner's 100,000 characters. */
export const PERSONAL_AGENT_ROUTINE_INSTRUCTIONS_MAX_LENGTH = 60_000
export const PERSONAL_AGENT_MEMORY_MAX_LENGTH = 20_000
export const PERSONAL_AGENT_MEMORY_NOTE_MAX_LENGTH = 2_000
export const PERSONAL_AGENT_ROUTINE_STATE_MAX_LENGTH = 4_000
export const PERSONAL_AGENT_TOOL_POLICY_MAX_CONNECTIONS = 100
export const PERSONAL_AGENT_TOOL_POLICY_MAX_TOOLS = 200
export const PERSONAL_AGENT_TOOL_POLICY_MAX_BLOCKED = 200
/** Every block is one scope on the run's credential, which stores at most 64 KiB of them. */
export const PERSONAL_AGENT_TOOL_POLICY_MAX_SCOPE_CHARACTERS = 32_000

/**
 * "ask" lets a run see the tool but not use it until a person says yes: the
 * call is refused and a request waits in the agent's chat.
 */
export const personalAgentAccessSchema = z.enum(["allow", "ask", "block"]).meta({ ref: "PersonalAgentAccess" })
export type PersonalAgentAccess = z.infer<typeof personalAgentAccessSchema>

const connectionIdSchema = z.string().trim().min(1).max(160)
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const toolNameSchema = z.string().min(1).max(128).refine((name) => !LONE_SURROGATE.test(name), "Expected well-formed text")

/**
 * What an agent may use of its owner's connections while it runs unattended.
 *
 * An agent starts with every connection the person it runs for has. A tool
 * that only reads is allowed; a tool that can change something asks first.
 * `connections` blocks a whole connection; `tools` sets single tools of a
 * connection that stays allowed to allow, ask or block. A blocked connection
 * wins over its tools.
 */
export const personalAgentToolPolicySchema = z.object({
  connections: z.record(connectionIdSchema, personalAgentAccessSchema).default({}),
  tools: z.record(connectionIdSchema, z.record(toolNameSchema, personalAgentAccessSchema)).default({}),
}).strict().superRefine((policy, context) => {
  if (Object.keys(policy.connections).length > PERSONAL_AGENT_TOOL_POLICY_MAX_CONNECTIONS
    || Object.keys(policy.tools).length > PERSONAL_AGENT_TOOL_POLICY_MAX_CONNECTIONS) {
    context.addIssue({ code: "custom", message: `A tool policy may name at most ${PERSONAL_AGENT_TOOL_POLICY_MAX_CONNECTIONS} connections.` })
  }
  let blocked = Object.values(policy.connections).filter((access) => access === "block").length
  for (const [connectionId, tools] of Object.entries(policy.tools)) {
    if (Object.keys(tools).length > PERSONAL_AGENT_TOOL_POLICY_MAX_TOOLS) {
      context.addIssue({ code: "custom", path: ["tools", connectionId], message: `A tool policy may name at most ${PERSONAL_AGENT_TOOL_POLICY_MAX_TOOLS} tools of one connection.` })
    }
    blocked += Object.values(tools).filter((access) => access === "block").length
  }
  if (blocked > PERSONAL_AGENT_TOOL_POLICY_MAX_BLOCKED) {
    context.addIssue({ code: "custom", message: `A tool policy may block at most ${PERSONAL_AGENT_TOOL_POLICY_MAX_BLOCKED} connections and tools. Block the whole connection instead.` })
  }
}).meta({ ref: "PersonalAgentToolPolicy" })
export type PersonalAgentToolPolicy = z.infer<typeof personalAgentToolPolicySchema>

export const EMPTY_PERSONAL_AGENT_TOOL_POLICY: PersonalAgentToolPolicy = { connections: {}, tools: {} }

export const personalAgentBriefSchema = z.string().trim().min(1).max(PERSONAL_AGENT_BRIEF_MAX_LENGTH)
  .describe("The agent's definition, as Markdown: who it is, what it does, how it reports. Every run of the agent starts from it.")

/** Stored for the per-agent spending limit; nothing enforces it yet. */
export const personalAgentMonthlyBudgetSchema = z.number().int().nonnegative().max(1_000_000_000_000)
  .describe("Monthly spending limit in millionths of a US dollar. Recorded now; not enforced yet.")

export const personalAgentStateSchema = z.enum(["active", "archived"]).meta({ ref: "PersonalAgentState" })
export type PersonalAgentState = z.infer<typeof personalAgentStateSchema>

export const personalAgentRoleSchema = z.enum(["owner", "manager", "collaborator"]).meta({ ref: "PersonalAgentRole" })
export type PersonalAgentRole = z.infer<typeof personalAgentRoleSchema>

/** What an owner can give a teammate. A manager changes the agent's job; a collaborator uses it and asks for changes. */
export const personalAgentShareRoleSchema = z.enum(["manager", "collaborator"]).meta({ ref: "PersonalAgentShareRole" })
export type PersonalAgentShareRole = z.infer<typeof personalAgentShareRoleSchema>

export const personalAgentPersonSchema = z.object({
  memberId: idSchema,
  name: z.string().max(240),
}).meta({ ref: "PersonalAgentPerson" })
export type PersonalAgentPerson = z.infer<typeof personalAgentPersonSchema>

export const personalAgentShareSchema = personalAgentPersonSchema.extend({
  role: personalAgentShareRoleSchema,
  createdAt: timestampSchema,
}).meta({ ref: "PersonalAgentShare" })
export type PersonalAgentShare = z.infer<typeof personalAgentShareSchema>

export const personalAgentShareListSchema = z.object({
  owner: personalAgentPersonSchema,
  items: z.array(personalAgentShareSchema),
}).meta({ ref: "PersonalAgentShareList" })
export type PersonalAgentShareList = z.infer<typeof personalAgentShareListSchema>

export const setPersonalAgentShareSchema = z.object({
  role: personalAgentShareRoleSchema,
}).strict().meta({ ref: "SetPersonalAgentShare" })
export type SetPersonalAgentShare = z.infer<typeof setPersonalAgentShareSchema>

export const personalAgentSchema = z.object({
  id: idSchema,
  organizationId: idSchema,
  ownerMemberId: idSchema,
  name: z.string().trim().min(1).max(PERSONAL_AGENT_NAME_MAX_LENGTH),
  state: personalAgentStateSchema,
  currentRevisionId: idSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  archivedAt: timestampSchema.nullable(),
  pausedAt: timestampSchema.nullable().default(null)
    .describe("Set while an organization admin has paused the agent: nothing of it runs until it is resumed."),
}).meta({ ref: "PersonalAgent" })
export type PersonalAgent = z.infer<typeof personalAgentSchema>

export const personalAgentRevisionSchema = z.object({
  id: idSchema,
  agentId: idSchema,
  version: z.number().int().positive(),
  brief: personalAgentBriefSchema,
  toolPolicy: personalAgentToolPolicySchema,
  defaultExecutionTarget: automationExecutionTargetSchema,
  monthlyBudgetMicros: personalAgentMonthlyBudgetSchema.nullable(),
  digest: z.string().trim().min(16).max(128),
  createdAt: timestampSchema,
}).meta({ ref: "PersonalAgentRevision" })
export type PersonalAgentRevision = z.infer<typeof personalAgentRevisionSchema>

/**
 * Who may use an agent besides the people it is shared with one by one: the
 * whole organization, or teams. They use it as collaborators. `autoAdd` puts
 * the agent in their sidebar without them opening it first.
 */
export const personalAgentAudienceSchema = z.object({
  organization: z.boolean(),
  autoAddOrganization: z.boolean(),
  teams: z.array(z.object({ teamId: idSchema, name: z.string().max(240), autoAdd: z.boolean() })),
}).meta({ ref: "PersonalAgentAudience" })
export type PersonalAgentAudience = z.infer<typeof personalAgentAudienceSchema>

const NO_AUDIENCE: PersonalAgentAudience = { organization: false, autoAddOrganization: false, teams: [] }

export const setPersonalAgentAudienceSchema = z.object({
  organization: z.boolean(),
  autoAddOrganization: z.boolean().optional(),
  teams: z.array(z.object({ teamId: idSchema, autoAdd: z.boolean().optional() }).strict()).max(50),
}).strict().meta({ ref: "SetPersonalAgentAudience" })
export type SetPersonalAgentAudience = z.infer<typeof setPersonalAgentAudienceSchema>

export const personalAgentRoutineSummarySchema = z.object({
  id: idSchema,
  name: z.string().max(120),
  state: automationStateSchema,
  schedule: automationScheduleSchema,
  nextDueAt: timestampSchema.nullable(),
  latestRun: z.object({
    id: idSchema,
    status: automationRunStatusSchema,
    createdAt: timestampSchema,
    finishedAt: timestampSchema.nullable(),
  }).nullable(),
}).meta({ ref: "PersonalAgentRoutineSummary" })
export type PersonalAgentRoutineSummary = z.infer<typeof personalAgentRoutineSummarySchema>

/**
 * What an agent has cost this calendar month (UTC) and the most it may cost.
 * `unpricedTokens` counts tokens of runs whose price is not known; they are
 * not in `monthMicros`.
 */
export const personalAgentSpendSchema = z.object({
  monthMicros: z.number().int().nonnegative(),
  unpricedTokens: z.number().int().nonnegative(),
  budgetMicros: personalAgentMonthlyBudgetSchema.nullable()
    .describe("The limit that applies: the lowest of the owner's, the admin's for this agent and the organization's."),
  ownerBudgetMicros: personalAgentMonthlyBudgetSchema.nullable(),
  adminBudgetMicros: personalAgentMonthlyBudgetSchema.nullable(),
  overBudget: z.boolean(),
}).meta({ ref: "PersonalAgentSpend" })
export type PersonalAgentSpend = z.infer<typeof personalAgentSpendSchema>

const NO_SPEND: PersonalAgentSpend = { monthMicros: 0, unpricedTokens: 0, budgetMicros: null, ownerBudgetMicros: null, adminBudgetMicros: null, overBudget: false }

export const personalAgentDetailSchema = z.object({
  agent: personalAgentSchema,
  revision: personalAgentRevisionSchema,
  routineCount: z.number().int().nonnegative(),
  role: personalAgentRoleSchema.default("owner").describe("What the caller may do with this agent."),
  owner: personalAgentPersonSchema.nullable().default(null),
  sharedWith: z.array(personalAgentShareSchema).default([]),
  routines: z.array(personalAgentRoutineSummarySchema).default([]),
  spend: personalAgentSpendSchema.default(NO_SPEND),
  openRequestCount: z.number().int().nonnegative().default(0),
  audience: personalAgentAudienceSchema.default(NO_AUDIENCE),
  listed: z.boolean().default(true)
    .describe("False when the caller can use the agent through their organization or a team but has not opened it and it was not added for them: offer it, do not list it."),
  canShare: z.boolean().default(true)
    .describe("Whether the caller may share this agent now: their role allows it and the organization lets them."),
}).meta({ ref: "PersonalAgentDetail" })
export type PersonalAgentDetail = z.infer<typeof personalAgentDetailSchema>

export const personalAgentListSchema = z.object({
  items: z.array(personalAgentDetailSchema),
  nextCursor: z.string().nullable(),
}).meta({ ref: "PersonalAgentList" })
export type PersonalAgentList = z.infer<typeof personalAgentListSchema>

/**
 * Something the person said the agent must never do, in their words: an app
 * ("Slack") and optionally an action ("post message"). Den turns each into
 * Block entries of the tool policy; an action it cannot match blocks every
 * tool of that app that can change something.
 */
export const personalAgentNeverSchema = z.object({
  app: z.string().trim().min(1).max(80),
  action: z.string().trim().min(1).max(120).optional(),
}).strict().meta({ ref: "PersonalAgentNever" })
export type PersonalAgentNever = z.infer<typeof personalAgentNeverSchema>

export const createPersonalAgentSchema = z.object({
  name: z.string().trim().min(1).max(PERSONAL_AGENT_NAME_MAX_LENGTH),
  brief: personalAgentBriefSchema,
  toolPolicy: personalAgentToolPolicySchema.optional(),
  never: z.array(personalAgentNeverSchema).max(20).optional(),
  defaultExecutionTarget: automationExecutionTargetSchema.optional(),
  monthlyBudgetMicros: personalAgentMonthlyBudgetSchema.nullable().optional(),
  idempotencyKey: z.string().trim().min(8).max(128).optional()
    .describe("Sending the same key again returns the agent the first request made instead of making another."),
}).strict().meta({ ref: "CreatePersonalAgent" })
export type CreatePersonalAgent = z.infer<typeof createPersonalAgentSchema>

export const updatePersonalAgentSchema = z.object({
  name: z.string().trim().min(1).max(PERSONAL_AGENT_NAME_MAX_LENGTH).optional(),
  brief: personalAgentBriefSchema.optional(),
  toolPolicy: personalAgentToolPolicySchema.optional(),
  defaultExecutionTarget: automationExecutionTargetSchema.optional(),
  monthlyBudgetMicros: personalAgentMonthlyBudgetSchema.nullable().optional(),
}).strict().refine((input) => Object.keys(input).length > 0, "At least one field is required")
  .meta({ ref: "UpdatePersonalAgent" })
export type UpdatePersonalAgent = z.infer<typeof updatePersonalAgentSchema>

/**
 * A routine is an ordinary Cloud Automation that belongs to the agent. Its
 * instructions say what this routine does; the agent's brief is added in front
 * of them when it runs.
 */
export const createPersonalAgentRoutineSchema = z.object({
  name: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(PERSONAL_AGENT_ROUTINE_INSTRUCTIONS_MAX_LENGTH)
    .describe("What this routine does each time it runs. The agent's brief is added in front of it."),
  schedule: automationScheduleSchema,
  model: automationModelSchema.optional()
    .describe("Omit to run on the organization's cloud default model."),
  executionTarget: z.literal("cloud").optional()
    .describe("A routine always runs in OpenWork Cloud; this may be omitted."),
}).strict().meta({ ref: "CreatePersonalAgentRoutine" })
export type CreatePersonalAgentRoutine = z.infer<typeof createPersonalAgentRoutineSchema>

export const PERSONAL_AGENT_ROUTINE_LIST_LIMIT = 100

export const personalAgentRoutineListSchema = z.object({
  items: z.array(automationDetailSchema),
}).meta({ ref: "PersonalAgentRoutineList" })
export type PersonalAgentRoutineList = z.infer<typeof personalAgentRoutineListSchema>

/**
 * What a desktop chat hands back when a person describes an agent: the agent
 * and its first routine, for the person to start with one confirmation. A
 * proposal is inert; the renderer creates both when the person says yes.
 */
export const personalAgentProposalSchema = z.object({
  name: z.string().trim().min(1).max(PERSONAL_AGENT_NAME_MAX_LENGTH),
  brief: personalAgentBriefSchema,
  never: z.array(personalAgentNeverSchema).max(20).optional(),
  routine: z.object({
    name: z.string().trim().min(1).max(120),
    instructions: z.string().trim().min(1).max(PERSONAL_AGENT_ROUTINE_INSTRUCTIONS_MAX_LENGTH),
    schedule: automationScheduleSchema,
  }).strict(),
}).strict().meta({ ref: "PersonalAgentProposal" })
export type PersonalAgentProposal = z.infer<typeof personalAgentProposalSchema>

export const runPersonalAgentNowSchema = z.object({
  routineId: idSchema.optional()
    .describe("Which of the agent's routines to run. Optional when the agent has exactly one."),
}).strict().meta({ ref: "RunPersonalAgentNow" })
export type RunPersonalAgentNow = z.infer<typeof runPersonalAgentNowSchema>

export const personalAgentRunResponseSchema = z.object({
  run: automationRunSchema,
  routine: automationDetailSchema,
  agentRevision: personalAgentRevisionSchema.pick({ id: true, version: true }),
}).meta({ ref: "PersonalAgentRunResponse" })
export type PersonalAgentRunResponse = z.infer<typeof personalAgentRunResponseSchema>

/** A change to a routine, by someone who may change the agent's job. `active: false` pauses the routine. */
export const updatePersonalAgentRoutineSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  instructions: z.string().trim().min(1).max(PERSONAL_AGENT_ROUTINE_INSTRUCTIONS_MAX_LENGTH).optional(),
  schedule: automationScheduleSchema.optional(),
  active: z.boolean().optional(),
}).strict().refine((input) => Object.keys(input).length > 0, "At least one field is required")
  .meta({ ref: "UpdatePersonalAgentRoutine" })
export type UpdatePersonalAgentRoutine = z.infer<typeof updatePersonalAgentRoutineSchema>

export const personalAgentRunListSchema = z.object({
  items: z.array(automationRunSchema),
}).meta({ ref: "PersonalAgentRunList" })
export type PersonalAgentRunList = z.infer<typeof personalAgentRunListSchema>

export const personalAgentChatSchema = z.object({
  agentId: idSchema,
  workspaceId: z.string().trim().min(1).max(240),
  sessionId: z.string().trim().min(1).max(240),
  updatedAt: timestampSchema,
}).meta({ ref: "PersonalAgentChat" })
export type PersonalAgentChat = z.infer<typeof personalAgentChatSchema>

export const personalAgentChatResponseSchema = z.object({
  chat: personalAgentChatSchema.nullable(),
}).meta({ ref: "PersonalAgentChatResponse" })
export type PersonalAgentChatResponse = z.infer<typeof personalAgentChatResponseSchema>

export const setPersonalAgentChatSchema = z.object({
  workspaceId: z.string().trim().min(1).max(240),
  sessionId: z.string().trim().min(1).max(240),
}).strict().meta({ ref: "SetPersonalAgentChat" })
export type SetPersonalAgentChat = z.infer<typeof setPersonalAgentChatSchema>

/** What a collaborator asks to change. A schedule or instructions change names the routine unless the agent has one. */
export const personalAgentChangeSchema = z.object({
  routineId: idSchema.optional(),
  schedule: automationScheduleSchema.optional(),
  instructions: z.string().trim().min(1).max(PERSONAL_AGENT_ROUTINE_INSTRUCTIONS_MAX_LENGTH).optional(),
  brief: personalAgentBriefSchema.optional(),
  name: z.string().trim().min(1).max(120).optional().describe("A new name for the routine."),
  active: z.boolean().optional().describe("Turn the routine on or off."),
  toolPolicy: personalAgentToolPolicySchema.optional().describe("The agent's tool settings after the change."),
  memoryNote: z.string().trim().min(1).max(PERSONAL_AGENT_MEMORY_NOTE_MAX_LENGTH).optional()
    .describe("Something for the agent to remember, added to its memory when the owner approves."),
  newRoutine: z.object({
    name: z.string().trim().min(1).max(120),
    instructions: z.string().trim().min(1).max(PERSONAL_AGENT_ROUTINE_INSTRUCTIONS_MAX_LENGTH),
    schedule: automationScheduleSchema,
  }).strict().optional().describe("A routine to add to the agent."),
}).strict().refine((change) => Boolean(change.schedule || change.instructions || change.brief || change.name || change.active !== undefined || change.newRoutine || change.toolPolicy || change.memoryNote), "Say what to change")
  .meta({ ref: "PersonalAgentChange" })
export type PersonalAgentChange = z.infer<typeof personalAgentChangeSchema>

export const personalAgentRequestKindSchema = z.enum(["tool", "change"]).meta({ ref: "PersonalAgentRequestKind" })
export type PersonalAgentRequestKind = z.infer<typeof personalAgentRequestKindSchema>

export const personalAgentRequestStatusSchema = z.enum(["pending", "denied", "allowed_once", "always_allowed", "approved", "used"])
  .meta({ ref: "PersonalAgentRequestStatus" })
export type PersonalAgentRequestStatus = z.infer<typeof personalAgentRequestStatusSchema>

/**
 * Something waiting on a person. kind "tool": a run was refused a tool until
 * someone allows it. kind "change": a collaborator asked for a change to the
 * agent's job.
 */
export const personalAgentRequestSchema = z.object({
  id: idSchema,
  agentId: idSchema,
  kind: personalAgentRequestKindSchema,
  status: personalAgentRequestStatusSchema,
  requestedBy: personalAgentPersonSchema,
  requestedByCaller: z.boolean().default(false).describe("True when the caller is the person the request is for."),
  runId: idSchema.nullable(),
  connectionId: z.string().max(160).nullable(),
  connectionName: z.string().max(160).nullable(),
  toolName: z.string().max(128).nullable(),
  toolTitle: z.string().max(240).nullable(),
  summary: z.string().max(500).nullable(),
  change: personalAgentChangeSchema.nullable(),
  decidedBy: personalAgentPersonSchema.nullable(),
  decidedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  canDecide: z.array(z.enum(["deny", "allow_once", "always_allow", "approve"]))
    .describe("The decisions the caller may make on this request; empty when it is not theirs to decide or already decided."),
}).meta({ ref: "PersonalAgentRequest" })
export type PersonalAgentRequest = z.infer<typeof personalAgentRequestSchema>

export const personalAgentRequestListSchema = z.object({
  items: z.array(personalAgentRequestSchema),
}).meta({ ref: "PersonalAgentRequestList" })
export type PersonalAgentRequestList = z.infer<typeof personalAgentRequestListSchema>

export const createPersonalAgentChangeRequestSchema = z.object({
  summary: z.string().trim().min(1).max(500).describe("The change in one plain sentence, as the person asked for it."),
  change: personalAgentChangeSchema,
}).strict().meta({ ref: "CreatePersonalAgentChangeRequest" })
export type CreatePersonalAgentChangeRequest = z.infer<typeof createPersonalAgentChangeRequestSchema>

export const personalAgentRequestDecisionSchema = z.enum(["deny", "allow_once", "always_allow", "approve"])
  .meta({ ref: "PersonalAgentRequestDecision" })
export type PersonalAgentRequestDecision = z.infer<typeof personalAgentRequestDecisionSchema>

export const decidePersonalAgentRequestSchema = z.object({
  decision: personalAgentRequestDecisionSchema,
}).strict().meta({ ref: "DecidePersonalAgentRequest" })
export type DecidePersonalAgentRequest = z.infer<typeof decidePersonalAgentRequestSchema>

export const personalAgentToolSchema = z.object({
  name: z.string().max(128),
  title: z.string().max(240),
  write: z.boolean().describe("False only when the connector says the tool reads and cannot destroy."),
  access: personalAgentAccessSchema.describe("What applies to a run now."),
  chosen: personalAgentAccessSchema.nullable().describe("What the agent's own policy says for this tool, if anything."),
  lockedByOrganization: z.boolean().describe("An admin blocked it for every agent; the agent's policy cannot change that."),
  organizationRule: z.enum(["ask", "allow"]).nullable().default(null)
    .describe("An admin's rule for every agent: \"ask\" always asks first whatever the agent says; \"allow\" is allowed unless the agent says ask or block."),
}).meta({ ref: "PersonalAgentTool" })
export type PersonalAgentTool = z.infer<typeof personalAgentToolSchema>

export const personalAgentConnectionToolsSchema = z.object({
  connectionId: idSchema,
  name: z.string().max(160),
  available: z.boolean().describe("Whether the caller is connected to it. Tools are listed only then."),
  blocked: z.boolean().describe("The agent's policy blocks the whole connection."),
  lockedByOrganization: z.boolean(),
  sharedLogin: personalAgentPersonSchema.nullable().default(null)
    .describe("Set when someone lent their own account on this connection to the agent: everyone's runs of the agent act through that person's account here."),
  canShareLogin: z.boolean().default(false)
    .describe("The caller may lend their own account on this connection to the agent, or take it back: the organization allows shared logins, the caller is its owner or a manager and is connected."),
  tools: z.array(personalAgentToolSchema),
}).meta({ ref: "PersonalAgentConnectionTools" })
export type PersonalAgentConnectionTools = z.infer<typeof personalAgentConnectionToolsSchema>

export const personalAgentToolCatalogSchema = z.object({
  connections: z.array(personalAgentConnectionToolsSchema),
}).meta({ ref: "PersonalAgentToolCatalog" })
export type PersonalAgentToolCatalog = z.infer<typeof personalAgentToolCatalogSchema>

/** Small facts about a change, for the list of who changed what. Never a brief or tool arguments. */
export const personalAgentEventDetailSchema = z.record(z.string().max(64), z.union([z.string().max(240), z.number(), z.boolean(), z.null()]))
export type PersonalAgentEventDetail = z.infer<typeof personalAgentEventDetailSchema>

export const personalAgentEventSchema = z.object({
  id: idSchema,
  agentId: idSchema.nullable(),
  agentName: z.string().max(PERSONAL_AGENT_NAME_MAX_LENGTH).nullable(),
  actor: personalAgentPersonSchema,
  action: z.string().max(64),
  detail: personalAgentEventDetailSchema,
  createdAt: timestampSchema,
}).meta({ ref: "PersonalAgentEvent" })
export type PersonalAgentEvent = z.infer<typeof personalAgentEventSchema>

export const personalAgentEventListSchema = z.object({
  items: z.array(personalAgentEventSchema),
  nextCursor: z.string().nullable().describe("Pass as cursor to read older changes; null when there are no more."),
}).meta({ ref: "PersonalAgentEventList" })
export type PersonalAgentEventList = z.infer<typeof personalAgentEventListSchema>

export const PERSONAL_AGENT_ORG_RULES_MAX_LENGTH = 4_000

export const personalAgentShareModeSchema = z.enum(["everyone", "admins"]).meta({ ref: "PersonalAgentShareMode" })
export type PersonalAgentShareMode = z.infer<typeof personalAgentShareModeSchema>

/**
 * What an organization decides for every agent. In `toolPolicy`, "block" means
 * no agent may use the tool, "ask" means every agent asks first whatever its
 * own setting, and "allow" means the tool is allowed unless the agent itself
 * says ask or block. A whole connection can only be blocked.
 */
export const personalAgentOrgPolicySchema = z.object({
  toolPolicy: personalAgentToolPolicySchema,
  monthlyBudgetMicros: personalAgentMonthlyBudgetSchema.nullable()
    .describe("The most one agent may spend in a month, whatever its owner chose."),
  shareMode: personalAgentShareModeSchema.default("everyone")
    .describe("Who may share agents: everyone, or organization admins only. Agents already shared stay shared."),
  sharedLogins: z.boolean().default(false)
    .describe("Whether an owner or manager may lend their own account on a connection to an agent so everyone who runs it acts through that account."),
  rules: z.string().max(PERSONAL_AGENT_ORG_RULES_MAX_LENGTH).default("")
    .describe("Rules every run of every agent is told to follow, in the admin's words."),
}).meta({ ref: "PersonalAgentOrgPolicy" })
export type PersonalAgentOrgPolicy = z.infer<typeof personalAgentOrgPolicySchema>

export const setPersonalAgentOrgPolicySchema = z.object({
  toolPolicy: personalAgentToolPolicySchema.optional(),
  monthlyBudgetMicros: personalAgentMonthlyBudgetSchema.nullable().optional(),
  shareMode: personalAgentShareModeSchema.optional(),
  sharedLogins: z.boolean().optional(),
  rules: z.string().max(PERSONAL_AGENT_ORG_RULES_MAX_LENGTH).optional(),
}).strict().refine((input) => Object.keys(input).length > 0, "At least one field is required")
  .meta({ ref: "SetPersonalAgentOrgPolicy" })
export type SetPersonalAgentOrgPolicy = z.infer<typeof setPersonalAgentOrgPolicySchema>

/** One agent as an organization admin sees it. Never its brief. */
export const personalAgentAdminItemSchema = z.object({
  agent: personalAgentSchema,
  owner: personalAgentPersonSchema,
  sharedWith: z.array(personalAgentShareSchema),
  writeAccess: z.object({
    allowed: z.number().int().nonnegative(),
    ask: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  }).describe("How many tools its policy names as allow, ask and block."),
  spend: personalAgentSpendSchema,
  routines: z.array(personalAgentRoutineSummarySchema),
  audience: personalAgentAudienceSchema.default(NO_AUDIENCE),
}).meta({ ref: "PersonalAgentAdminItem" })
export type PersonalAgentAdminItem = z.infer<typeof personalAgentAdminItemSchema>

export const personalAgentAdminListSchema = z.object({
  items: z.array(personalAgentAdminItemSchema),
  policy: personalAgentOrgPolicySchema,
  monthMicros: z.number().int().nonnegative().describe("What every agent in the organization has cost this month."),
}).meta({ ref: "PersonalAgentAdminList" })
export type PersonalAgentAdminList = z.infer<typeof personalAgentAdminListSchema>

export const setPersonalAgentAdminBudgetSchema = z.object({
  monthlyBudgetMicros: personalAgentMonthlyBudgetSchema.nullable(),
}).strict().meta({ ref: "SetPersonalAgentAdminBudget" })
export type SetPersonalAgentAdminBudget = z.infer<typeof setPersonalAgentAdminBudgetSchema>

export const transferPersonalAgentSchema = z.object({
  memberId: idSchema.describe("The member who becomes the owner. They must be in the organization."),
}).strict().meta({ ref: "TransferPersonalAgent" })
export type TransferPersonalAgent = z.infer<typeof transferPersonalAgentSchema>

export const setPersonalAgentSharedLoginSchema = z.object({
  shared: z.boolean().describe("True lends the caller's own account on this connection to the agent; false takes it back."),
}).strict().meta({ ref: "SetPersonalAgentSharedLogin" })
export type SetPersonalAgentSharedLogin = z.infer<typeof setPersonalAgentSharedLoginSchema>

/** A manager's routine change waits for the owner, because scheduled runs act with the owner's accounts. */
export const personalAgentPendingChangeSchema = z.object({
  request: personalAgentRequestSchema,
}).meta({ ref: "PersonalAgentPendingChange" })
export type PersonalAgentPendingChange = z.infer<typeof personalAgentPendingChangeSchema>

/**
 * What an agent keeps between runs. `notes` is the agent's memory: the owner
 * and managers can read and edit it, the agent adds to it while it runs for
 * its owner, and everyone the agent is shared with can read it. `routines`
 * holds, per routine, what its last run for the owner did, so the next run
 * does not do it again.
 */
export const personalAgentMemorySchema = z.object({
  notes: z.string().max(PERSONAL_AGENT_MEMORY_MAX_LENGTH),
  version: z.number().int().nonnegative().describe("Send it back when saving; a save against an older version is refused."),
  updatedAt: timestampSchema.nullable(),
  updatedBy: personalAgentPersonSchema.nullable().describe("The person who last edited the notes; null when the agent wrote them in a run or nothing was written yet."),
  canEdit: z.boolean().describe("The caller is the owner or a manager."),
  routines: z.array(z.object({
    routineId: idSchema,
    name: z.string().max(120),
    state: z.string().max(PERSONAL_AGENT_ROUTINE_STATE_MAX_LENGTH),
    updatedAt: timestampSchema,
  })).describe("What each routine's last run for the owner did."),
}).meta({ ref: "PersonalAgentMemory" })
export type PersonalAgentMemory = z.infer<typeof personalAgentMemorySchema>

export const setPersonalAgentMemorySchema = z.object({
  notes: z.string().max(PERSONAL_AGENT_MEMORY_MAX_LENGTH),
  expectedVersion: z.number().int().nonnegative(),
}).strict().meta({ ref: "SetPersonalAgentMemory" })
export type SetPersonalAgentMemory = z.infer<typeof setPersonalAgentMemorySchema>

/** One thing to remember. The owner's and a manager's note is added at once; anyone else's waits for the owner's yes. */
export const rememberForPersonalAgentSchema = z.object({
  note: z.string().trim().min(1).max(PERSONAL_AGENT_MEMORY_NOTE_MAX_LENGTH).describe("One short fact or preference, in plain words."),
}).strict().meta({ ref: "RememberForPersonalAgent" })
export type RememberForPersonalAgent = z.infer<typeof rememberForPersonalAgentSchema>
