import { canonicalAuditJson, type AuditEventInput } from "@openwork-ee/den-db/audit-log"
import type { AuditChangeEventInput } from "../request-capture.js"

// Shared helpers for the domain change emitters (src/audit/domain/*). Every
// serializer picks an explicit allowlist of fields; nothing here copies rows.

export type AuditSnapshot = Record<string, unknown>
export type AuditResourceRef = AuditEventInput["resources"][number]

export const AUDIT_TEXT_WITHHELD = "[withheld]"
const credentialLike = /\b(?:Bearer|Basic)\s|-----BEGIN [A-Z ]*PRIVATE KEY-----|enc:v1:|https?:\/\/[^\s/]+@|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|AIza[A-Za-z0-9_-]{25,})/i

/**
 * Bounded single-line identity text (names, roles, emails, issuers). Values that
 * could carry credential material, control characters or exceed the bound are
 * replaced by a fixed marker instead of failing the business mutation.
 */
export function auditText(value: string | null | undefined, maximum = 255): string | null {
  if (value === null || value === undefined) return null
  if (value.length > maximum || /[\u0000-\u001f\u007f]/.test(value) || credentialLike.test(value)) return AUDIT_TEXT_WITHHELD
  return value
}

export function auditTime(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

/** Own property of an untyped hook payload (better-auth rows and endpoint contexts). */
export function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined
  return Object.getOwnPropertyDescriptor(value, key)?.value
}
export function stringOf(value: unknown, key: string): string | null {
  const field = fieldOf(value, key)
  return typeof field === "string" && field.trim() ? field.trim() : null
}
/** ISO time of a Date or date string field, else null. */
export function timeOf(value: unknown, key: string): string | null {
  const field = fieldOf(value, key)
  const time = field instanceof Date ? field.getTime() : typeof field === "string" ? Date.parse(field) : Number.NaN
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

/** before/after snapshots with changedFields computed from them plus opaque markers. */
export function auditChanges(before: AuditSnapshot | null, after: AuditSnapshot | null, markers: readonly string[] = []): NonNullable<AuditEventInput["changes"]> {
  return { before, after, changedFields: [...new Set([...changedSnapshotFields(before, after), ...markers])].sort() }
}

export function targetResource(type: string, id: string, label?: string | null): AuditResourceRef {
  const safeLabel = auditText(label ?? null)
  return { type, id, relationship: "target", ...(safeLabel && safeLabel !== AUDIT_TEXT_WITHHELD ? { label: safeLabel } : {}) }
}
export function organizationParent(organizationId: string): AuditResourceRef {
  return { type: "organization", id: organizationId, relationship: "parent" }
}
export function relatedResource(type: string, id: string): AuditResourceRef {
  return { type, id, relationship: "related" }
}

export function changedSnapshotFields(before: AuditSnapshot | null, after: AuditSnapshot | null): string[] {
  return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
    .filter((field) => canonicalAuditJson(before?.[field] ?? null) !== canonicalAuditJson(after?.[field] ?? null)).sort()
}

/**
 * One change event (create: before null; delete: after null). Returns null for a
 * no-op update (no changed field and no marker) so nothing is appended. Markers
 * name changes whose values are never retained (e.g. "credentialMaterial").
 * Annotations describe the action, not the resource (e.g. reasonProvided): they
 * are added to `after` but never count as a change.
 */
export function auditChangeEvent(input: {
  action: string
  resources: readonly (AuditResourceRef | null)[]
  before: AuditSnapshot | null
  after: AuditSnapshot | null
  markers?: readonly string[]
  annotations?: AuditSnapshot
  reasonCode?: string
  category?: AuditEventInput["category"]
}): AuditChangeEventInput | null {
  const changedFields = [...new Set([...changedSnapshotFields(input.before, input.after), ...(input.markers ?? [])])].sort()
  if (input.before && input.after && changedFields.length === 0) return null
  const resources: AuditResourceRef[] = []
  for (const resource of input.resources) {
    if (resource && !resources.some((entry) => entry.type === resource.type && entry.id === resource.id && entry.relationship === resource.relationship)) resources.push(resource)
  }
  return {
    action: input.action, resources, changes: { before: input.before, after: input.after && input.annotations ? { ...input.after, ...input.annotations } : input.after, changedFields },
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}), ...(input.category ? { category: input.category } : {}),
  }
}
