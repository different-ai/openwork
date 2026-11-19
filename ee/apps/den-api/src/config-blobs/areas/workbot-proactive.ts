/**
 * Config-blob area `workbot.proactive` (Manage › Workbot › members' agents):
 * one item holding how members' agents work in the organization.
 *
 * - Carried: the policy saved in `organization.metadata.workbot.proactive`
 *   (on/off, working hours, daily limit, members' starting choice, default
 *   destination), what agents may read (`sources`), the brief an admin saved
 *   under `workbotAgentBrief` (only the fields they saved, and only while
 *   that feature is on for the exporting member), and the content
 *   of the "Your agent" template (responsibilities and organization
 *   instructions; each save on the target adds a template version).
 * - Connections in `sources` are references: an MCP connection is
 *   `{ $ref: "connectors.mcp/<id>", name }`; one of Den's own providers
 *   (Google Workspace, Microsoft 365, …) is `{ native: "<provider key>" }`,
 *   matched on the target by its provider. A connection the target doesn't
 *   have is left out with a warning.
 * - Never carried: each member's agent (agent_instance and their own
 *   choices: personal), checks, deliveries and health counts (runtime), the
 *   Workbot Slack installation (secrets and a workspace binding).
 *
 * Apply goes through PUT /v1/org/workbot-settings/proactive's own function
 * (`saveWorkbotProactiveSettings`): the brief gate, the sources check and the
 * working-hours rule are the dashboard's. Only the fields the plan changes are
 * sent.
 *
 * What the target can't take is left out with a warning, never a failed run:
 * a connection agents can't read here (the save's own rule: an MCP without
 * reviewed read tools while `workbotAgentBrief` is off), the brief and the
 * per-tool choices while that feature is off. `preflight` computes the same
 * change at plan time, so an item that would write nothing is planned as a
 * skip with the reason, and what will be left out is said before approval.
 */
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { configRefSchema } from "@openwork/types/den/config-blobs"
import {
  AGENT_BRIEF_FIELDS,
  AGENT_CORE_SOURCES,
  AGENT_INSTRUCTIONS_MAX,
  AGENT_RESPONSIBILITIES,
  WORKBOT_PROACTIVE_LEAD_MINUTES,
  agentSourcePolicySchema,
  agentToolOverrideSchema,
  storedAgentBriefSchema,
  type AgentSourcesPolicy,
  type AgentSourcesPolicyInput,
  type WorkbotProactiveSettingsInput,
} from "@openwork/types/den/workbot-proactive"
import { z } from "zod"
import { saveWorkbotProactiveSettings } from "../../routes/org/workbot-settings.js"
import { agentBriefAllowed, readProactiveSettings } from "../../workbot-proactive/access.js"
import { canBeSource, sourceSlotsOf, type SourceMode } from "../../workbot-proactive/sources.js"
import { listOrganizationSourceConnections } from "../../workbot-proactive/sources-repository.js"
import { readAgentTemplate } from "../../workbot-proactive/template.js"
import { workbotOrigin } from "../../workbot/config.js"
import { defineConfigArea, type ConfigApplyOp, type ConfigAreaContext, type ConfigItem, type ConfigPreflightInfo } from "../area.js"
import { DROP_ENTRY, rewriteRefs } from "../engine/refs.js"
import { ApplySteps, ConfigFieldError, ORG_SINGLETON_NATURAL_KEY, readSingleton, requireActorPermission, touches } from "./org-singleton.js"
import { specObject } from "./route-support.js"

const AREA = "workbot.proactive"
const ITEM_NAME = "Members' agents"
const MCP_AREA = "connectors.mcp"

// ---------------------------------------------------------------------------
// Spec

const connectionIdSchema = z.string().trim().min(1).max(64)
const nativeConnectionSchema = z.object({ native: z.string().trim().min(1).max(64) }).strict()
/** Blob form: a reference or a native provider. At apply, a resolved reference also carries the local `id`. */
const connectionSchema = z.union([configRefSchema.extend({ id: z.string().min(1).optional() }).strict(), nativeConnectionSchema])
type SpecConnection = z.infer<typeof connectionSchema>

const leadMinutesSchema = z.number().int().refine((value) => WORKBOT_PROACTIVE_LEAD_MINUTES.some((allowed) => allowed === value), {
  message: "Choose 5, 10, 15, 30 or 60 minutes.",
})
/** `optionalConnection`: at apply, a reference the admin chose to drop is removed, leaving the entry without one. */
function specSchema(optionalConnection: boolean) {
  const entryConnection = optionalConnection ? connectionSchema.optional() : connectionSchema
  return z.object({
    enabled: z.boolean().default(false),
    leadMinutes: leadMinutesSchema.default(15),
    workingDays: z.enum(["weekdays", "everyday"]).default("weekdays"),
    startHour: z.number().int().min(0).max(23).default(8),
    endHour: z.number().int().min(1).max(24).default(19),
    dailyCap: z.number().int().min(1).max(10).default(3),
    membersStart: z.enum(["opted_in", "opted_out"]).default("opted_in"),
    destination: z.enum(["workbot_dm"]).nullable().default("workbot_dm"),
    sources: z.object({
      calendar: agentSourcePolicySchema.default("everyone"),
      /**
       * In files exported before mail and chat became part of their connections and the calendar app stopped being
       * picked. Read so those files still import; never applied and no longer exported.
       */
      email: z.unknown().optional(),
      chat: z.unknown().optional(),
      coreConnections: z.unknown().optional(),
      coreDefaults: z.unknown().optional(),
      /** Null: every connection whose read tools are reviewed. */
      otherConnections: z.array(connectionSchema).max(2000).nullable().default(null),
      /** Other connections that aren't "members choose". */
      connections: z.array(z.object({ connection: entryConnection, policy: z.enum(["everyone", "off"]) }).strict()).max(2000).default([]),
      /** `workbotAgentBrief`: an admin's choice per tool, per connection. */
      toolOverrides: z.array(z.object({
        connection: entryConnection,
        tools: z.record(z.string().trim().min(1).max(255), agentToolOverrideSchema),
      }).strict()).max(2000).default([]),
    }).strict().default({
      calendar: "everyone",
      otherConnections: null, connections: [], toolOverrides: [],
    }),
    /** `workbotAgentBrief`: only the fields an admin saved; the rest is carried over on the target. */
    brief: storedAgentBriefSchema.strict().default({}),
    /** The "Your agent" template's content. */
    template: z.object({
      responsibilities: z.object({
        morning_brief: z.boolean(),
        meeting_prep: z.boolean(),
        calendar_changes: z.boolean(),
        waiting_on_you: z.boolean(),
      }).strict().default({ morning_brief: true, meeting_prep: true, calendar_changes: true, waiting_on_you: true }),
      instructions: z.string().max(AGENT_INSTRUCTIONS_MAX).default(""),
    }).strict().default({ responsibilities: { morning_brief: true, meeting_prep: true, calendar_changes: true, waiting_on_you: true }, instructions: "" }),
  }).strict()
}

const proactiveSpecSchema = specSchema(false)
const applySpecSchema = specSchema(true)
type ApplySpec = z.infer<typeof applySpecSchema>

const POLICY_FIELDS = ["enabled", "leadMinutes", "workingDays", "startHour", "endHour", "dailyCap", "membersStart", "destination"] as const

// ---------------------------------------------------------------------------
// Connections

type TargetConnection = { id: string; name: string; url: string; native: string | null }

async function organizationConnections(organizationId: string): Promise<TargetConnection[]> {
  return listOrganizationSourceConnections(normalizeDenTypeId("organization", organizationId))
}

function toSpecConnection(id: string, connections: Map<string, TargetConnection>): SpecConnection | null {
  const connection = connections.get(id)
  if (!connection) return null
  if (connection.native !== null) return { native: connection.native }
  return { $ref: `${MCP_AREA}/${connection.id}`, name: connection.name }
}

function specConnectionKey(connection: SpecConnection): string {
  return "native" in connection ? `native:${connection.native}` : connection.$ref
}

function sortConnections(list: SpecConnection[]): SpecConnection[] {
  return [...list].sort((a, b) => specConnectionKey(a).localeCompare(specConnectionKey(b)))
}

function exportList(ids: readonly string[] | undefined, connections: Map<string, TargetConnection>): SpecConnection[] | null {
  if (!ids) return null
  return sortConnections(ids.flatMap((id) => {
    const connection = toSpecConnection(id, connections)
    return connection ? [connection] : []
  }))
}

/** The target's connection for a spec connection; null (with a warning) when the target has none. */
function localConnection(connection: SpecConnection | undefined, connections: readonly TargetConnection[], warnings: Set<string>): string | null {
  if (!connection) return null
  if ("native" in connection) {
    const matches = connections.filter((entry) => entry.native === connection.native)
    // A connection row wins over the legacy provider-level setup (whose id is the provider key).
    const found = matches.find((entry) => entry.id !== connection.native) ?? matches[0]
    if (found) return found.id
    warnings.add(`The ${connection.native} connection isn't set up in this organization; members' agents can't read it here.`)
    return null
  }
  const id = connection.id
  if (id && connections.some((entry) => entry.id === id)) return id
  warnings.add(`The connection "${connection.name ?? connection.$ref}" isn't in this organization; it is left out of what agents read.`)
  return null
}

function localList(list: readonly SpecConnection[] | null, connections: readonly TargetConnection[], warnings: Set<string>): string[] | null {
  if (!list) return null
  return [...new Set(list.flatMap((connection) => {
    const id = localConnection(connection, connections, warnings)
    return id ? [id] : []
  }))]
}

// ---------------------------------------------------------------------------
// Export

async function exportItems(ctx: ConfigAreaContext): Promise<ConfigItem[]> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const [settings, template, connectionList, briefOn] = await Promise.all([
    readProactiveSettings(organizationId),
    readAgentTemplate(organizationId),
    organizationConnections(organizationId),
    agentBriefAllowed(organizationId, ctx.actor.userId),
  ])
  const connections = new Map(connectionList.map((connection) => [connection.id, connection]))
  const { sources } = settings
  const policyEntries = Object.entries(sources.connections)
    .flatMap(([id, policy]) => {
      const connection = policy === "members" ? null : toSpecConnection(id, connections)
      return connection && policy !== "members" ? [{ connection, policy }] : []
    })
    .sort((a, b) => specConnectionKey(a.connection).localeCompare(specConnectionKey(b.connection)))
  const toolOverrides = Object.entries(sources.toolOverrides ?? {})
    .flatMap(([id, tools]) => {
      const connection = toSpecConnection(id, connections)
      const sorted = Object.fromEntries(Object.entries(tools).sort(([a], [b]) => a.localeCompare(b)))
      return connection && Object.keys(sorted).length ? [{ connection, tools: sorted }] : []
    })
    .sort((a, b) => specConnectionKey(a.connection).localeCompare(specConnectionKey(b.connection)))

  const spec = {
    enabled: settings.enabled,
    leadMinutes: settings.leadMinutes,
    workingDays: settings.workingDays,
    startHour: settings.startHour,
    endHour: settings.endHour,
    dailyCap: settings.dailyCap,
    membersStart: settings.membersStart,
    destination: settings.destination,
    sources: {
      calendar: sources.calendar,
      otherConnections: exportList(sources.otherConnections, connections),
      connections: policyEntries,
      toolOverrides,
    },
    // As the dashboard: the saved brief only while Your agent's brief is on for the actor. Off, it is left
    // out, and an import without it leaves the target's saved brief as it is (apply never clears a field).
    brief: briefOn ? { ...settings.brief } : {},
    template: { responsibilities: { ...template.responsibilities }, instructions: template.instructions },
  }
  return [{ id: ctx.organizationId, name: ITEM_NAME, spec }]
}

// ---------------------------------------------------------------------------
// Apply

function sameSet(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  if (!a || !b) return (a ?? null) === (b ?? null)
  return a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000")
}

function sameTools(a: Readonly<Record<string, string>> | undefined, b: Readonly<Record<string, string>> | undefined): boolean {
  const left = Object.entries(a ?? {}).sort(([x], [y]) => x.localeCompare(y))
  const right = Object.entries(b ?? {}).sort(([x], [y]) => x.localeCompare(y))
  return JSON.stringify(left) === JSON.stringify(right)
}

function listed(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

/**
 * The smallest sources change that turns `current` into `spec`, limited to what the op touches. A connection the
 * save would refuse (checkSourcesChange, with the same `mode`) is left out with a warning: the organization the
 * file came from may read connections this one can't yet.
 */
function sourcesChange(op: ConfigApplyOp, spec: ApplySpec["sources"], current: AgentSourcesPolicy, connections: readonly TargetConnection[], mode: SourceMode, warnings: Set<string>): AgentSourcesPolicyInput {
  const change: AgentSourcesPolicyInput = {}
  const byId = new Map(connections.map((connection) => [connection.id, connection]))
  const unreadable = new Set<string>()
  const notOther = new Set<string>()
  for (const kind of AGENT_CORE_SOURCES) {
    if (touches(op, `sources.${kind}`) && spec[kind] !== current[kind]) change[kind] = spec[kind]
  }
  if (touches(op, "sources.otherConnections")) {
    const found = localList(spec.otherConnections, connections, warnings)
    const wanted = found === null ? null : found.filter((id) => {
      const connection = byId.get(id)
      if (!connection || sourceSlotsOf(connection, mode).includes("other")) return true
      if (connection.native !== null) notOther.add(connection.name)
      else unreadable.add(connection.name)
      return false
    })
    if (!sameSet(wanted, current.otherConnections)) change.otherConnections = wanted
  }
  if (touches(op, "sources.connections")) {
    const wanted = new Map<string, "everyone" | "off">()
    for (const entry of spec.connections) {
      const id = localConnection(entry.connection, connections, warnings)
      if (!id) continue
      const connection = byId.get(id)
      if (connection && !canBeSource(connection, mode)) {
        // "Not allowed" needs no saying: agents can't read it here either way.
        if (entry.policy !== "off") unreadable.add(connection.name)
        continue
      }
      wanted.set(id, entry.policy)
    }
    const policies: Record<string, "everyone" | "members" | "off" | null> = {}
    for (const id of new Set([...wanted.keys(), ...Object.keys(current.connections)])) {
      const next = wanted.get(id) ?? "members"
      const now = current.connections[id] ?? "members"
      if (next !== now) policies[id] = next === "members" ? null : next
    }
    if (Object.keys(policies).length) change.connections = policies
  }
  if (touches(op, "sources.toolOverrides")) {
    const wanted = new Map<string, Record<string, "allow" | "deny">>()
    for (const entry of spec.toolOverrides) {
      const id = localConnection(entry.connection, connections, warnings)
      if (id) wanted.set(id, entry.tools)
    }
    const overrides: NonNullable<AgentSourcesPolicyInput["toolOverrides"]> = {}
    const currentOverrides = current.toolOverrides ?? {}
    for (const id of new Set([...wanted.keys(), ...Object.keys(currentOverrides)])) {
      const next = wanted.get(id)
      const now = currentOverrides[id]
      if (sameTools(next, now)) continue
      if (!next) {
        overrides[id] = null
        continue
      }
      const tools: Record<string, "allow" | "deny" | null> = {}
      for (const name of new Set([...Object.keys(next), ...Object.keys(now ?? {})])) {
        const value = next[name]
        if (value !== now?.[name]) tools[name] = value ?? null
      }
      overrides[id] = tools
    }
    if (Object.keys(overrides).length) change.toolOverrides = overrides
  }
  if (unreadable.size) {
    const names = [...unreadable].sort()
    warnings.add(names.length === 1
      ? `Agents can't read ${names[0]} here yet; it is left out of what agents read.`
      : `Agents can't read ${listed(names)} here yet; they are left out of what agents read.`)
  }
  if (notOther.size) {
    const names = [...notOther].sort()
    warnings.add(`${listed(names)} can't be other context here; ${names.length === 1 ? "it is" : "they are"} left out.`)
  }
  return change
}

type TargetState = {
  settings: Awaited<ReturnType<typeof readProactiveSettings>>
  template: Awaited<ReturnType<typeof readAgentTemplate>>
  connections: TargetConnection[]
  /** `workbotAgentBrief` for the applier: the brief, per-tool choices and any connection as a source. */
  briefOn: boolean
}

async function readTargetState(ctx: ConfigAreaContext): Promise<TargetState> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const [settings, template, connections, briefOn] = await Promise.all([
    readProactiveSettings(organizationId),
    readAgentTemplate(organizationId),
    organizationConnections(organizationId),
    agentBriefAllowed(organizationId, ctx.actor.userId),
  ])
  return { settings, template, connections, briefOn }
}

/**
 * What the op would save here, and what it leaves out and why. Shared by `apply` and `preflight`, so the plan says
 * what the apply does. An empty change means the item writes nothing.
 */
function plannedChange(op: ConfigApplyOp, spec: ApplySpec, state: TargetState): { change: WorkbotProactiveSettingsInput; warnings: string[] } {
  const { settings, template, connections, briefOn } = state
  const warnings = new Set<string>()
  const change: WorkbotProactiveSettingsInput = {}

  if (touches(op, "enabled") && spec.enabled !== settings.enabled) change.enabled = spec.enabled
  if (touches(op, "leadMinutes") && spec.leadMinutes !== settings.leadMinutes) change.leadMinutes = spec.leadMinutes
  if (touches(op, "workingDays") && spec.workingDays !== settings.workingDays) change.workingDays = spec.workingDays
  if (touches(op, "startHour") && spec.startHour !== settings.startHour) change.startHour = spec.startHour
  if (touches(op, "endHour") && spec.endHour !== settings.endHour) change.endHour = spec.endHour
  if (touches(op, "dailyCap") && spec.dailyCap !== settings.dailyCap) change.dailyCap = spec.dailyCap
  if (touches(op, "membersStart") && spec.membersStart !== settings.membersStart) change.membersStart = spec.membersStart
  if (touches(op, "destination") && spec.destination !== settings.destination) change.destination = spec.destination

  // The save checks sources under the same mode (saveWorkbotProactiveSettings).
  const sources = sourcesChange(op, spec.sources, settings.sources, connections, briefOn ? "any" : "reviewed", warnings)
  if (sources.toolOverrides && !briefOn) {
    delete sources.toolOverrides
    warnings.add("Choosing tools for agents isn't on for this organization; the tool choices are left out.")
  }
  if (Object.keys(sources).length) change.sources = sources

  const brief: NonNullable<WorkbotProactiveSettingsInput["brief"]> = {}
  for (const field of AGENT_BRIEF_FIELDS) {
    if (!touches(op, `brief.${field}`)) continue
    const wanted = spec.brief[field]
    const saved = settings.brief?.[field]
    if (wanted === undefined) {
      if (saved !== undefined) warnings.add(`The brief's ${field} stays as saved here: an import can't clear a saved brief field.`)
      continue
    }
    if (wanted === saved) continue
    if (field === "text" && typeof wanted === "string") brief.text = wanted
    else if (field === "checkEveryHours" && (wanted === 1 || wanted === 2 || wanted === 3 || wanted === 4)) brief.checkEveryHours = wanted
    else if (field === "dailyCap" && typeof wanted === "number") brief.dailyCap = wanted
    else if (field === "extraChecksPerDay" && typeof wanted === "number") brief.extraChecksPerDay = wanted
  }
  if (Object.keys(brief).length) {
    if (briefOn) change.brief = brief
    else warnings.add("Your agent's brief isn't on for this organization; the brief settings are left out.")
  }

  const responsibilities: NonNullable<WorkbotProactiveSettingsInput["responsibilities"]> = {}
  for (const responsibility of AGENT_RESPONSIBILITIES) {
    const wanted = spec.template.responsibilities[responsibility]
    if (touches(op, `template.responsibilities.${responsibility}`) && wanted !== template.responsibilities[responsibility]) responsibilities[responsibility] = wanted
  }
  if (Object.keys(responsibilities).length) change.responsibilities = responsibilities
  if (touches(op, "template.instructions") && spec.template.instructions.trim() !== template.instructions) change.instructions = spec.template.instructions.trim()

  return { change, warnings: [...warnings] }
}

const WORKBOT_OFF = "Workbot isn't on for this deployment, so members' agents can't be set up here."

/**
 * The op's spec as the apply gets it, built from how the plan resolved each connection: a connection the
 * organization already holds carries its local `id`, a dropped one is removed. Null when a connection the op
 * writes isn't known yet (this same plan creates it, or the admin still has to decide): nothing can be said
 * about it before the apply.
 */
function resolvedPreview(op: ConfigApplyOp & { kind: "create" | "update" }, refs: NonNullable<ConfigPreflightInfo["refs"]>): { [key: string]: unknown } | null {
  const byPath = new Map(refs.map((ref) => [ref.path, ref]))
  let pending = false
  const out = rewriteRefs(specObject(op.item.spec), (path, ref) => {
    const found = byPath.get(path)
    // The entry goes with a dropped connection (`requiredRefs`); in `otherConnections` the entry is the connection.
    if (found?.resolution === "drop") return DROP_ENTRY
    if (found?.resolution === "target" && found.id) return { ...ref, id: found.id }
    // `sources.connections[0].connection` is written when the op touches `sources.connections`.
    const field = /^sources\.[A-Za-z]+/.exec(path)?.[0] ?? path
    if (touches(op, field)) pending = true
    return ref
  })
  return pending ? null : specObject(out)
}

function describeChange(change: WorkbotProactiveSettingsInput): Array<{ target: string }> {
  const targets: Array<{ target: string }> = []
  for (const field of POLICY_FIELDS) if (change[field] !== undefined) targets.push({ target: field })
  for (const [key, value] of Object.entries(change.sources ?? {})) {
    if (value !== undefined) targets.push({ target: `sources.${key}` })
  }
  for (const key of Object.keys(change.brief ?? {})) targets.push({ target: `brief.${key}` })
  return targets
}

export const workbotProactiveArea = defineConfigArea({
  key: AREA,
  label: "Members' agents",
  path: ["Manage", "Workbot", "Members' agents"],
  specVersion: 1,
  specSchema: proactiveSpecSchema,
  dependsOn: [MCP_AREA],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "inference.view",
  managePermission: "inference.manage",
  // organization.metadata.workbot.proactive (owned table: organization, by settings.general) and the "Your agent"
  // template, a config_object of type `agent` with its versions (tables owned by plugins.skills, which must skip it).
  tables: [],
  naturalKeys: [ORG_SINGLETON_NATURAL_KEY],
  secretFields: [],
  // A connection's policy and its tool choices are about that connection: dropped, they go with it.
  requiredRefs: ["sources.connections[].connection", "sources.toolOverrides[].connection"],
  // Organization instructions and the brief are prompts the organization wrote.
  containsConfidentialContent: true,
  // saveWorkbotProactiveSettings writes through updateOrganizationMetadata and saveAgentTemplate on the global db.
  transactional: false,
  protectedFromDelete: () => "The settings for members' agents can't be deleted.",

  irreversible(op) {
    if (op.kind === "delete") return []
    const next = specObject(op.item.spec)
    const before = op.kind === "update" ? op.previous.spec.enabled : false
    if (next.enabled === true && before !== true) {
      return ["Members' agents turn on: they start reading members' calendars, email and chat, and messages they send members can't be unsent."]
    }
    return []
  },

  exportItems,
  readItems: (ctx, ids) => readSingleton(ctx, ids, exportItems),

  /**
   * Plan time: an import that would write nothing here is planned as a skip with what it leaves out, and what an
   * import that does write leaves out is said before approval. Connections this same plan creates are judged by
   * the apply.
   */
  async preflight(ctx, op, info) {
    if (op.kind === "delete") return null
    if (workbotOrigin() === null) return { skip: WORKBOT_OFF }
    if (!info.refs) return null
    const preview = resolvedPreview(op, info.refs)
    if (!preview) return null
    const parsed = applySpecSchema.safeParse(preview)
    if (!parsed.success) return null
    const { change, warnings } = plannedChange(op, parsed.data, await readTargetState(ctx))
    if (Object.keys(change).length === 0) return { skip: warnings.length ? warnings.join(" ") : "Members' agents are already set up this way here." }
    return warnings.length ? { warnings } : null
  },

  async apply(ctx, op) {
    const steps = new ApplySteps()
    if (op.kind === "delete") throw steps.fail("not_deletable", "The settings for members' agents can't be deleted.")
    const localId = ctx.organizationId
    const parsed = applySpecSchema.safeParse(specObject(op.item.spec))
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw steps.fail("invalid_spec", issue?.message ?? "Invalid settings.", issue?.path.join(".") || undefined)
    }
    if (workbotOrigin() === null) throw steps.fail("feature_disabled", WORKBOT_OFF, undefined, 404)
    const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
    const memberId = normalizeDenTypeId("member", ctx.actor.memberId)
    const { change, warnings } = plannedChange(op, parsed.data, await readTargetState(ctx))

    if (Object.keys(change).length === 0) return { localId, steps: [], warnings }

    const planned = [
      ...describeChange(change).map(({ target }) => ({ action: "set" as const, target })),
      ...(change.responsibilities || change.instructions !== undefined ? [{ action: "create" as const, target: "template", detail: "new template version" }] : []),
    ]
    const step = { action: "update" as const, target: "settings", detail: planned.map((entry) => entry.target).join(", ") }
    await steps.run(step, undefined, async () => {
      await requireActorPermission(ctx, "inference.manage")
      const saved = await saveWorkbotProactiveSettings({ organizationId, memberId, userId: ctx.actor.userId, change })
      if (!saved.ok) {
        const field = saved.error === "invalid_working_hours" ? "endHour" : saved.error === "invalid_sources" ? "sources" : "brief"
        throw new ConfigFieldError(saved.error === "invalid_sources" ? "invalid_request" : saved.error, saved.message, field, 400)
      }
    })
    return { localId, steps: planned, warnings }
  },
})
