import { readFileSync, writeFileSync } from "node:fs"
import { api, ApiError } from "../api.ts"
import type { Session } from "../config.ts"
import { confirmDestructive, noArgs, oneArg, openSession, withRecentSignIn, type Context } from "../context.ts"
import { parseApplyReport, parseChangeRequest, parseChangeRequests, parseConfigAreas, parsePlan, type ApplyReport, type ChangeRequest, type FieldChange, type Plan, type PlanItem, type PlanSummary } from "../den-config.ts"
import { CliError } from "../io.ts"
import { field, items, strings, text } from "../json.ts"
import { emit, table } from "../output.ts"

const BASE = "/v1/config-blobs"
const POLL_MS = 2000
const ANALYSIS_POLLS = 150
const APPLY_POLLS = 450
const BLOCKING_FLAGS = new Set(["needs_mapping", "needs_input", "ref_unresolved", "drift", "collision.unique", "conflict.identity", "blocked"])
const CHANGE_MARKS: Record<string, string> = { create: "+", update: "~", rename: "~", delete: "-" }

async function configApi(context: Context, session: Session, method: string, path: string, body?: unknown): Promise<unknown> {
  try {
    return await api(context.io, session, method, `${BASE}${path}`, body)
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "config_scope_required") throw error
    throw new CliError("config_scope_required", `${session.source} is not a config token with the ${text(error.details, "scope")} scope. Create a config token in Settings › API keys, or sign in with \`openwork auth login\`.`, error.details)
  }
}

function requestPath(id: string, rest = ""): string {
  return `/change-requests/${encodeURIComponent(id)}${rest}`
}

function importMode(context: Context): string {
  const mode = context.flags.mode ?? "merge"
  if (mode !== "merge" && mode !== "mirror") throw new CliError("usage", "--mode is merge (create and update only) or mirror (also delete what the file leaves out).")
  return mode
}

function readConfigFile(path: string): unknown {
  let contents: string
  try {
    contents = readFileSync(path, "utf8")
  } catch {
    throw new CliError("file_not_found", `Could not read ${path}.`)
  }
  try {
    return JSON.parse(contents)
  } catch {
    throw new CliError("invalid_config_file", `${path} is not valid JSON.`)
  }
}

function changeCount(summary: PlanSummary): number {
  return summary.create + summary.update + summary.rename + summary.delete
}

function summaryText(summary: PlanSummary): string {
  const parts = [
    [summary.create, "to create"],
    [summary.update, "to update"],
    [summary.rename, "to rename"],
    [summary.delete, "to delete"],
    [summary.skip, "skipped"],
    [summary.blocking, "needing a decision"],
  ].filter(([amount]) => amount !== 0).map(([amount, label]) => `${amount} ${label}`)
  return parts.length ? `${parts.join(", ")} (${summary.unchanged} unchanged)` : `No changes (${summary.unchanged} unchanged)`
}

function shortValue(value: unknown): string {
  const written = value === undefined ? "nothing" : JSON.stringify(value)
  return written.length > 60 ? `${written.slice(0, 57)}...` : written
}

function fieldText(change: FieldChange): string {
  const listed = [...change.added.map((value) => `+${shortValue(value)}`), ...change.removed.map((value) => `-${shortValue(value)}`)]
  return listed.length ? `${change.path}: ${listed.join(", ")}` : `${change.path}: ${shortValue(change.from)} → ${shortValue(change.to)}`
}

function isBlocked(item: PlanItem): boolean {
  return item.flags.some((flag) => BLOCKING_FLAGS.has(flag))
}

function itemLines(item: PlanItem): string[] {
  const blocked = isBlocked(item)
  const mark = blocked ? "!" : CHANGE_MARKS[item.op]
  if (!mark) return []
  const why = blocked ? [`needs a decision: ${[...item.flags.filter((flag) => BLOCKING_FLAGS.has(flag)), ...item.reasons].join("; ")}`] : []
  const fields = item.op === "create" ? [] : item.fields.slice(0, 8).map(fieldText)
  const more = item.op !== "create" && item.fields.length > 8 ? [`and ${item.fields.length - 8} more fields`] : []
  return [`  ${mark} ${item.op} ${item.name}`, ...[...why, ...fields, ...more].map((line) => `      ${line}`)]
}

function planText(plan: Plan): string {
  const areas = plan.areas.flatMap((area) => {
    const lines = area.items.flatMap(itemLines)
    return lines.length ? [`${area.label || area.area} (${area.area})`, ...lines] : []
  })
  const issues = plan.issues.filter((issue) => issue.level !== "info").map((issue) => `${issue.level}: ${issue.message}`)
  const kept = plan.mode === "mirror" && plan.summary.untouched > 0
    ? [`${plan.summary.untouched} items the file leaves out are kept. Deleting them is chosen item by item in the dashboard.`]
    : []
  return [`Plan (${plan.mode}): ${summaryText(plan.summary)}`, ...areas, ...kept, ...issues].join("\n")
}

function blockedText(plan: Plan): string {
  return plan.areas.flatMap((area) => area.items.filter(isBlocked).flatMap(itemLines)).join("\n")
}

type Preview = { plan: Plan; answer: unknown }

async function previewImport(context: Context, session: Session, blob: unknown, mode: string): Promise<Preview> {
  const answer = await configApi(context, session, "POST", "/change-requests?dryRun=true", { blob, mode })
  const plan = parsePlan(field(answer, "plan"))
  const errors = strings(answer, "errors")
  if (!plan || errors.length) throw new CliError("invalid_config_file", ["This file cannot be imported.", ...errors].join("\n"), answer)
  return { plan, answer }
}

async function readRequest(context: Context, session: Session, id: string): Promise<{ request: ChangeRequest; report: ApplyReport | null }> {
  const answer = await configApi(context, session, "GET", requestPath(id))
  return { request: parseChangeRequest(answer), report: parseApplyReport(answer) }
}

async function waitWhile(context: Context, session: Session, id: string, waiting: string[], polls: number): Promise<{ request: ChangeRequest; report: ApplyReport | null }> {
  let current = await readRequest(context, session, id)
  for (let poll = 0; poll < polls && waiting.includes(current.request.status); poll += 1) {
    await context.io.sleep(POLL_MS)
    current = await readRequest(context, session, id)
  }
  return current
}

async function readPlan(context: Context, session: Session, id: string): Promise<Preview> {
  const answer = await configApi(context, session, "GET", requestPath(id, "/plan"))
  const plan = parsePlan(field(answer, "plan"))
  if (!plan) throw new CliError("plan_not_ready", `Change request ${id} has no plan yet. Check it with \`openwork config status ${id}\`.`)
  return { plan, answer }
}

async function upload(context: Context, session: Session, blob: unknown, mode: string): Promise<{ request: ChangeRequest; plan: Plan; answer: unknown }> {
  const body = { blob, mode, ...(context.flags.title ? { title: context.flags.title } : {}) }
  const created = parseChangeRequest(await configApi(context, session, "POST", "/change-requests", body))
  const { request } = await waitWhile(context, session, created.id, ["uploaded", "analyzing"], ANALYSIS_POLLS)
  if (request.status === "invalid") throw new CliError("invalid_config_file", ["This file cannot be imported.", ...request.errors].join("\n"))
  if (request.status === "uploaded" || request.status === "analyzing") {
    throw new CliError("analysis_timeout", `Change request ${request.id} is still being analyzed. Check it with \`openwork config status ${request.id}\`.`)
  }
  return { request, ...(await readPlan(context, session, request.id)) }
}

export async function areas(context: Context): Promise<void> {
  noArgs(context)
  const session = await openSession(context)
  const listed = parseConfigAreas(await configApi(context, session, "GET", "/areas"))
  emit(context.io, context.json, { areas: listed }, table(["AREA", "NAME", "EXPORT", "IMPORT"],
    listed.map((area) => [area.key, area.label, area.supported && area.canExport ? "yes" : "no", area.supported && area.canImport ? "yes" : "no"])))
}

/** Download the configuration. Secrets are never in the file; each one is a placeholder. */
export async function pull(context: Context): Promise<void> {
  noArgs(context)
  const session = await openSession(context)
  const query = context.flags.areas ? `?areas=${encodeURIComponent(context.flags.areas)}` : ""
  const blob = await withRecentSignIn(context, session, (current) => configApi(context, current, "GET", `/export${query}`))
  const omitted = items(blob, "omitted").map((area) => `${text(area, "area")} (${text(area, "reason")})`)
  if (omitted.length) context.io.err(`Left out of the file: ${omitted.join(", ")}`)
  const contents = JSON.stringify(blob, null, 2)
  if (!context.flags.out) {
    context.io.out(contents)
    return
  }
  writeFileSync(context.flags.out, `${contents}\n`)
  const exported = strings(blob, "scope")
  emit(context.io, context.json, { file: context.flags.out, areas: exported, omitted }, `Saved ${exported.length} areas to ${context.flags.out}.`)
}

/** Show what importing a file would change, without storing anything. Answers saved from earlier imports are not applied to this preview. */
export async function diff(context: Context): Promise<void> {
  const blob = readConfigFile(oneArg(context, "config file"))
  const session = await openSession(context)
  const { plan, answer } = await previewImport(context, session, blob, importMode(context))
  emit(context.io, context.json, answer, planText(plan))
}

/** Upload a file as a change request and wait for its plan. Nothing is written to the organization until someone approves it. */
export async function push(context: Context): Promise<void> {
  if (context.flags.dryRun) return diff(context)
  const blob = readConfigFile(oneArg(context, "config file"))
  const session = await openSession(context)
  const { request, plan } = await upload(context, session, blob, importMode(context))
  emit(context.io, context.json, { changeRequest: { id: request.id, status: request.status, planHash: plan.planHash }, summary: plan.summary }, [
    `Change request ${request.id} is ready for review.`,
    planText(plan),
    `Nothing is written until it is approved. Deploy it with \`openwork config deploy --request ${request.id}\`, or review it in the dashboard under Settings › Config.`,
  ].join("\n"))
}

function refuseBlockedPlan(plan: Plan, id: string): void {
  if (plan.summary.blocking === 0) return
  throw new CliError("decisions_needed", [
    `${plan.summary.blocking} items in change request ${id} need a decision before it can be deployed:`,
    blockedText(plan),
    `Answer them in the dashboard under Settings › Config, then run \`openwork config deploy --request ${id}\`.`,
  ].join("\n"), { changeRequest: { id }, summary: plan.summary })
}

async function withdraw(context: Context, session: Session, id: string): Promise<boolean> {
  return configApi(context, session, "POST", requestPath(id, "/cancel")).then(() => true, () => false)
}

async function applyAndWait(context: Context, session: Session, id: string, planHash: string): Promise<void> {
  await withRecentSignIn(context, session, (current) => configApi(context, current, "POST", requestPath(id, "/apply"), { planHash })).catch((error: unknown) => {
    if (!(error instanceof ApiError) || error.status !== 409) throw error
    throw new CliError(error.code, `${error.message} Change request ${id} stays open: check it with \`openwork config status ${id}\`.`, error.details)
  })
  context.io.err(`Applying change request ${id}...`)
  const { request, report } = await waitWhile(context, session, id, ["approved", "queued", "applying"], APPLY_POLLS)
  if (request.status === "applied") {
    emit(context.io, context.json, { deployed: true, changeRequest: { id, status: request.status }, report },
      [`Deployed: ${report?.applied ?? 0} applied, ${report?.unchanged ?? 0} unchanged, ${report?.skipped ?? 0} skipped.`, ...(report?.warnings ?? [])].join("\n"))
    return
  }
  if (request.status === "failed") {
    throw new CliError("deploy_failed", [
      report?.failure ? `The deploy stopped at ${report.failure}` : "The deploy stopped part-way.",
      `Applied before it: ${report?.applied ?? 0}. Not reached: ${report?.notReached ?? 0}.`,
      `See the report with \`openwork config status ${id}\`. Applied items can be undone with Restore previous config in the dashboard.`,
    ].join("\n"), { changeRequest: { id, status: request.status }, report })
  }
  throw new CliError("deploy_not_finished", [`Change request ${id} is ${request.status}, not applied.`, ...request.errors, `Check it with \`openwork config status ${id}\`.`].join(" "))
}

function requireSomeoneToConfirm(context: Context): void {
  if (context.flags.force || context.io.interactive) return
  throw new CliError("confirmation_required", "Aborted. Pass --force to deploy when no one is at the terminal.")
}

async function deployRequest(context: Context, session: Session, id: string): Promise<void> {
  const { plan, answer } = await readPlan(context, session, id)
  refuseBlockedPlan(plan, id)
  if (context.flags.dryRun) return emit(context.io, context.json, answer, planText(plan))
  requireSomeoneToConfirm(context)
  context.io.err(planText(plan))
  if (!context.flags.force && !(await context.io.confirm(`Apply change request ${id} to the organization?`))) throw new CliError("aborted", "Aborted.")
  return applyAndWait(context, session, id, plan.planHash)
}

/**
 * Apply a file and wait for the result. The preview stores nothing and stops an
 * unusable or already-applied file early. The plan that is confirmed and applied
 * is the uploaded request's, because only it reuses the answers of earlier
 * imports. A declined or empty request is withdrawn; one that needs decisions
 * stays open for the dashboard.
 */
export async function deploy(context: Context): Promise<void> {
  const session = await openSession(context)
  if (context.flags.request) {
    noArgs(context)
    return deployRequest(context, session, context.flags.request)
  }
  const blob = readConfigFile(oneArg(context, "config file, or --request <id>"))
  const mode = importMode(context)
  const preview = await previewImport(context, session, blob, mode)
  if (context.flags.dryRun) return emit(context.io, context.json, preview.answer, planText(preview.plan))
  if (changeCount(preview.plan.summary) === 0 && preview.plan.summary.blocking === 0) return nothingToDeploy(context, preview.plan)
  requireSomeoneToConfirm(context)

  const { request, plan } = await upload(context, session, blob, mode)
  refuseBlockedPlan(plan, request.id)
  if (changeCount(plan.summary) === 0) {
    await withdraw(context, session, request.id)
    return nothingToDeploy(context, plan)
  }
  context.io.err(planText(plan))
  if (!context.flags.force && !(await context.io.confirm("Apply this plan to the organization?"))) {
    const withdrawn = await withdraw(context, session, request.id)
    throw new CliError("aborted", withdrawn ? `Aborted. Change request ${request.id} was withdrawn.` : `Aborted. Change request ${request.id} is still open: withdraw it with \`openwork config cancel ${request.id}\`.`)
  }
  return applyAndWait(context, session, request.id, plan.planHash)
}

function nothingToDeploy(context: Context, plan: Plan): void {
  emit(context.io, context.json, { deployed: false, summary: plan.summary }, "Nothing to deploy: the organization already matches the file.")
}

export async function requests(context: Context): Promise<void> {
  noArgs(context)
  const session = await openSession(context)
  const open = parseChangeRequests(await configApi(context, session, "GET", "/change-requests?state=open"))
  emit(context.io, context.json, { changeRequests: open }, open.length
    ? table(["ID", "STATUS", "MODE", "TITLE", "CHANGES", "CREATED"], open.map((request) => [request.id, request.status, request.mode, request.title, request.summary ? changeCount(request.summary) : null, request.createdAt.slice(0, 10)]))
    : "No open change requests.")
}

export async function status(context: Context): Promise<void> {
  const id = oneArg(context, "change request id")
  const session = await openSession(context)
  const { request, report } = await readRequest(context, session, id)
  emit(context.io, context.json, { changeRequest: request, report }, [
    `Change request ${request.id}: ${request.status}${request.title ? ` (${request.title})` : ""}`,
    ...(request.summary ? [`Plan (${request.mode}): ${summaryText(request.summary)}`] : []),
    `Approvals: ${request.approvals}`,
    ...request.errors,
    ...(report ? [`Last apply: ${report.status}, ${report.applied} applied, ${report.unchanged} unchanged, ${report.failed} failed, ${report.notReached} not reached`] : []),
    ...(report?.failure ? [`Stopped at ${report.failure}`] : []),
    ...(report?.warnings ?? []),
  ].join("\n"))
}

export async function cancel(context: Context): Promise<void> {
  const id = oneArg(context, "change request id")
  const session = await openSession(context)
  await confirmDestructive(context, `Withdraw change request ${id}?`)
  const request = parseChangeRequest(await configApi(context, session, "POST", requestPath(id, "/cancel")))
  emit(context.io, context.json, { changeRequest: { id: request.id, status: request.status } }, `Withdrew change request ${request.id}.`)
}
