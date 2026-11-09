/**
 * People references for callers who may not read the member directory
 * (format.md › People).
 *
 * Every area can carry `{ $ref: "people/<email>", name }` (grants,
 * assignments). Who may read other members' emails and names in a config
 * blob is the `members.people` area's view rule; anyone else gets the same
 * references as `{ $ref: "people/<member id>" }`, with no name, and plans,
 * reports and errors with those emails and names replaced.
 *
 * Import resolves either form. `namePeopleByEmail` turns `people/<member
 * id>` back into `people/<email>` for members of the TARGET organization
 * before planning, so a redacted export re-imported into its own
 * organization compares equal to what is there (no changes). A member id of
 * another organization stays as written: the reference is unresolved, and the
 * admin chooses a member or drops it (an id can't be invited).
 *
 * Pure: the member map comes in (normalized email → member id).
 */
import {
  CONFIG_AREA_KEYS,
  findConfigShapeProblem,
  flattenConfigAreas,
  isConfigRef,
  isConfigSecret,
  nestConfigAreas,
  parseConfigRef,
  type ConfigApplyReport,
  type ConfigApplyReportItem,
  type ConfigApplyStep,
  type ConfigAreaKey,
  type ConfigBlob,
  type ConfigBlobArea,
  type ConfigChangeRequestSummary,
  type ConfigFieldChange,
  type ConfigPlan,
  type ConfigPlanItem,
  type ConfigPlanRef,
  type ConfigRef,
  type ConfigSpec,
} from "@openwork/types/den/config-blobs"
import { findRefs, isEmailHandle, PEOPLE_AREA, rewriteRefs } from "./refs.js"
import { isPlainObject, isUnsafeKey, normalizeEmail } from "./util.js"

const PEOPLE_PREFIX = "people/"
/** Shown instead of an email or name the caller may not read. */
export const HIDDEN_PERSON = "(hidden)"
/** The handle of a person who is not a member here (`people/hidden`): never resolves. */
const HIDDEN_HANDLE = "hidden"
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi

function personTarget(ref: string): string | null {
  const parsed = parseConfigRef(ref)
  return parsed?.area === "people" ? parsed.target : null
}

/** Member id → email, from the member map (the first email of a member wins). */
function emailsById(people: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>()
  for (const [email, id] of people) if (!out.has(id)) out.set(id, email)
  return out
}

/**
 * The blob's areas with `people/<member id>` written as `people/<email>`
 * for members of the target organization; other references unchanged.
 */
export function namePeopleByEmail(
  blobAreas: Partial<Record<ConfigAreaKey, ConfigBlobArea>>,
  people: ReadonlyMap<string, string>,
): Partial<Record<ConfigAreaKey, ConfigBlobArea>> {
  const byId = emailsById(people)
  if (byId.size === 0) return blobAreas
  const rewrite = (ref: ConfigRef): ConfigRef => {
    const target = personTarget(ref.$ref)
    const email = target !== null && !isEmailHandle(target) ? byId.get(target) : undefined
    return email ? { ...ref, $ref: `${PEOPLE_PREFIX}${email}` } : ref
  }
  const out: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {}
  for (const key of CONFIG_AREA_KEYS) {
    const area = blobAreas[key]
    if (!area) continue
    out[key] = {
      ...area,
      items: area.items.map((item) => {
        // Only items that name someone by id are copied; a spec planning will refuse (forbidden keys, depth) stays as written.
        const byId = findRefs(item.spec).some((ref) => {
          const target = personTarget(ref.ref)
          return target !== null && !isEmailHandle(target)
        })
        if (!byId || findConfigShapeProblem(item.spec, "spec") !== null) return item
        const spec = rewriteRefs(item.spec, (_path, ref) => rewrite(ref))
        return { ...item, spec: isPlainObject(spec) ? spec : {} }
      }),
    }
  }
  return out
}

export type PeopleRedactor = {
  /** A spec (or any JSON) with people refs as `people/<member id>` and no name hints. Nothing else changes. */
  refs: (value: unknown) => unknown
  spec: (spec: ConfigSpec) => ConfigSpec
  blob: (blob: ConfigBlob) => ConfigBlob
  /** Text with the emails of people (members, and anyone a people ref names) and their name hints hidden. */
  text: (value: string) => string
  plan: (plan: ConfigPlan) => ConfigPlan
  report: (report: ConfigApplyReport) => ConfigApplyReport
  summary: (summary: ConfigChangeRequestSummary) => ConfigChangeRequestSummary
}

/**
 * `people`: the organization's members, normalized email → member id.
 * Display redaction (`text`, `plan`, `report`) also hides every email and
 * name hint a people reference in that value carries, so call it once per
 * value it is shown with.
 */
export function createPeopleRedactor(people: ReadonlyMap<string, string>): PeopleRedactor {
  const handleFor = (target: string): string => (isEmailHandle(target) ? people.get(normalizeEmail(target)) ?? HIDDEN_HANDLE : target)
  const refs = (value: unknown): unknown => rewriteRefs(value, (_path, ref) => {
    const target = personTarget(ref.$ref)
    if (target === null) return ref
    const out: { [key: string]: unknown } = { $ref: `${PEOPLE_PREFIX}${handleFor(target)}` }
    const resolved: unknown = Object.getOwnPropertyDescriptor(ref, "id")?.value
    if (typeof resolved === "string") out.id = resolved
    return out
  })
  const spec = (value: ConfigSpec): ConfigSpec => {
    const out = refs(value)
    return isPlainObject(out) ? out : {}
  }

  /** Emails and names that people refs in a value carry: hidden in its text too. */
  const collect = (value: unknown, emails: Set<string>, names: Set<string>): void => {
    if (Array.isArray(value)) {
      for (const element of value) collect(element, emails, names)
      return
    }
    if (!isPlainObject(value) || isConfigSecret(value)) return
    const handle = typeof value.$ref === "string" ? value.$ref : typeof value.ref === "string" ? value.ref : null
    const target = handle === null ? null : personTarget(handle)
    if (target !== null) {
      if (isEmailHandle(target)) emails.add(normalizeEmail(target))
      if (typeof value.name === "string" && value.name.trim()) names.add(value.name)
      return
    }
    for (const child of Object.values(value)) collect(child, emails, names)
  }

  const display = (root: unknown) => {
    const emails = new Set<string>()
    const names = new Set<string>()
    collect(root, emails, names)
    const text = (value: string): string => {
      if (names.has(value)) return HIDDEN_PERSON
      return value.replace(EMAIL_PATTERN, (match) => {
        const email = normalizeEmail(match)
        return people.get(email) ?? (emails.has(email) ? HIDDEN_PERSON : match)
      })
    }
    const value = (input: unknown): unknown => {
      if (typeof input === "string") return text(input)
      if (isConfigSecret(input)) return input
      if (isConfigRef(input)) return refs(input)
      if (Array.isArray(input)) return input.map(value)
      if (isPlainObject(input)) {
        const out: { [key: string]: unknown } = {}
        for (const [key, child] of Object.entries(input)) if (!isUnsafeKey(key)) out[key] = value(child)
        return out
      }
      return input
    }
    return { text, value }
  }

  const fieldChange = (view: ReturnType<typeof display>, change: ConfigFieldChange): ConfigFieldChange => {
    const out: ConfigFieldChange = { path: view.text(change.path) }
    if (change.from !== undefined) out.from = view.value(change.from)
    if (change.to !== undefined) out.to = view.value(change.to)
    if (change.base !== undefined) out.base = view.value(change.base)
    if (change.conflict !== undefined) out.conflict = change.conflict
    if (change.added) out.added = change.added.map(view.value)
    if (change.removed) out.removed = change.removed.map(view.value)
    return out
  }

  const planRef = (ref: ConfigPlanRef): ConfigPlanRef => {
    const target = personTarget(ref.ref)
    if (target === null) return ref
    const out: ConfigPlanRef = { path: ref.path, ref: `${PEOPLE_PREFIX}${handleFor(target)}`, resolvedId: ref.resolvedId, via: ref.via }
    if (ref.decision !== undefined) out.decision = ref.decision
    return out
  }

  const planItem = (view: ReturnType<typeof display>, item: ConfigPlanItem): ConfigPlanItem => {
    const person = item.area === PEOPLE_AREA
    const out: ConfigPlanItem = { ...item, fields: item.fields.map((change) => fieldChange(view, change)) }
    if (item.blob) out.blob = { ...item.blob, name: person ? item.blob.id ?? HIDDEN_PERSON : view.text(item.blob.name) }
    if (item.target) out.target = { ...item.target, name: person ? item.target.id : view.text(item.target.name) }
    if (item.reasons) out.reasons = item.reasons.map(view.text)
    if (item.irreversible) out.irreversible = item.irreversible.map(view.text)
    if (item.refs) out.refs = item.refs.map(planRef)
    if (item.candidates) {
      out.candidates = item.candidates.map((candidate) => ({ ...candidate, name: person ? candidate.id : view.text(candidate.name), reasons: candidate.reasons.map(view.text) }))
    }
    return out
  }

  const step = (view: ReturnType<typeof display>, value: ConfigApplyStep): ConfigApplyStep => (
    value.detail === undefined ? { ...value, target: view.text(value.target) } : { ...value, target: view.text(value.target), detail: view.text(value.detail) }
  )

  const reportItem = (view: ReturnType<typeof display>, item: ConfigApplyReportItem): ConfigApplyReportItem => {
    const out: ConfigApplyReportItem = {
      ...item,
      name: item.area === PEOPLE_AREA ? item.localId ?? HIDDEN_PERSON : view.text(item.name),
      steps: item.steps.map((entry) => step(view, entry)),
      warnings: item.warnings.map(view.text),
      irreversible: item.irreversible.map(view.text),
    }
    if (item.failure) {
      out.failure = { ...item.failure, message: view.text(item.failure.message) }
      if (item.failure.step) out.failure.step = step(view, item.failure.step)
    }
    if (item.error !== undefined) out.error = view.text(item.error)
    return out
  }

  return {
    refs,
    spec,
    blob: (blob) => {
      const flat = flattenConfigAreas(blob.areas).areas
      const areas: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {}
      for (const key of CONFIG_AREA_KEYS) {
        const area = flat[key]
        if (area) areas[key] = { ...area, items: area.items.map((item) => ({ ...item, spec: spec(item.spec) })) }
      }
      return { ...blob, areas: nestConfigAreas(areas) }
    },
    text: (value) => display(null).text(value),
    plan: (plan) => {
      const view = display(plan)
      return {
        ...plan,
        issues: plan.issues.map((issue) => ({ ...issue, message: view.text(issue.message) })),
        areas: plan.areas.map((area) => ({ ...area, items: area.items.map((item) => planItem(view, item)) })),
      }
    },
    report: (report) => {
      const view = display(report)
      return {
        ...report,
        failure: report.failure
          ? { ...report.failure, name: report.failure.area === PEOPLE_AREA ? HIDDEN_PERSON : view.text(report.failure.name), failure: { ...report.failure.failure, message: view.text(report.failure.failure.message) } }
          : null,
        items: report.items.map((item) => reportItem(view, item)),
        warnings: report.warnings.map(view.text),
      }
    },
    summary: (summary) => ({ ...summary, errors: summary.errors.map(display(null).text) }),
  }
}
