import { count, field, isRecord, items, optionalText, requiredText, strings, text } from "./json.ts"

export type PlanSummary = { create: number; update: number; rename: number; delete: number; unchanged: number; untouched: number; skip: number; blocking: number }
export type FieldChange = { path: string; from: unknown; to: unknown; added: unknown[]; removed: unknown[] }
export type PlanItem = { name: string; op: string; flags: string[]; reasons: string[]; fields: FieldChange[] }
export type PlanArea = { area: string; label: string; items: PlanItem[] }
export type Plan = { planHash: string; mode: string; summary: PlanSummary; areas: PlanArea[]; issues: { level: string; message: string }[] }
export type ChangeRequest = {
  id: string
  status: string
  title: string | null
  mode: string
  planHash: string | null
  summary: PlanSummary | null
  errors: string[]
  approvals: number
  createdAt: string
}
export type ApplyReport = { status: string; applied: number; unchanged: number; failed: number; notReached: number; skipped: number; failure: string | null; warnings: string[] }
export type ConfigArea = { key: string; label: string; supported: boolean; canExport: boolean; canImport: boolean }

function parseSummary(value: unknown): PlanSummary | null {
  if (!isRecord(value)) return null
  return {
    create: count(value, "create"),
    update: count(value, "update"),
    rename: count(value, "rename"),
    delete: count(value, "delete"),
    unchanged: count(value, "unchanged"),
    untouched: count(value, "untouched"),
    skip: count(value, "skip"),
    blocking: count(value, "blocking"),
  }
}

function parsePlanItem(item: unknown): PlanItem {
  return {
    name: optionalText(field(item, "blob"), "name") ?? optionalText(field(item, "target"), "name") ?? text(item, "ref"),
    op: text(item, "op"),
    flags: strings(item, "flags"),
    reasons: strings(item, "reasons"),
    fields: items(item, "fields").map((change) => ({
      path: text(change, "path"),
      from: field(change, "from"),
      to: field(change, "to"),
      added: items(change, "added"),
      removed: items(change, "removed"),
    })),
  }
}

export function parsePlan(value: unknown): Plan | null {
  const summary = parseSummary(field(value, "summary"))
  if (!summary) return null
  return {
    planHash: requiredText(value, "planHash"),
    mode: text(value, "mode"),
    summary,
    areas: items(value, "areas").map((area) => ({ area: text(area, "area"), label: text(area, "label"), items: items(area, "items").map(parsePlanItem) })),
    issues: items(value, "issues").map((issue) => ({ level: text(issue, "level"), message: text(issue, "message") })),
  }
}

export function parseChangeRequest(body: unknown): ChangeRequest {
  const request = field(body, "changeRequest")
  return {
    id: requiredText(request, "id"),
    status: requiredText(request, "status"),
    title: optionalText(request, "title"),
    mode: text(request, "mode"),
    planHash: optionalText(request, "planHash"),
    summary: parseSummary(field(request, "summary")),
    errors: strings(request, "errors"),
    approvals: items(request, "approvals").length,
    createdAt: text(request, "createdAt"),
  }
}

export function parseChangeRequests(body: unknown): ChangeRequest[] {
  return items(body, "changeRequests").map((changeRequest) => parseChangeRequest({ changeRequest }))
}

export function parseApplyReport(body: unknown): ApplyReport | null {
  const report = field(body, "report")
  if (!isRecord(report)) return null
  const counts = field(report, "counts")
  const failure = field(report, "failure")
  return {
    status: text(report, "status"),
    applied: count(counts, "applied"),
    unchanged: count(counts, "noop"),
    failed: count(counts, "failed"),
    notReached: count(counts, "not_reached"),
    skipped: count(counts, "skipped"),
    failure: isRecord(failure) ? `${text(failure, "name")} (${text(failure, "area")}): ${text(field(failure, "failure"), "message")}` : null,
    warnings: strings(report, "warnings"),
  }
}

export function parseConfigAreas(body: unknown): ConfigArea[] {
  return items(body, "areas").map((area) => ({
    key: requiredText(area, "key"),
    label: text(area, "label"),
    supported: field(area, "supported") === true,
    canExport: field(area, "canExport") === true,
    canImport: field(area, "canImport") === true,
  }))
}
