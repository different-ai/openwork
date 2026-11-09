/**
 * Builds the plan of a change request (mapping.md › Steps 3–7) and the
 * execution plan `executePlan` runs. Pure: everything the plan depends on
 * comes in through `BuildPlanInput`.
 */
import type { FeatureKey } from "@openwork/features"
import type {
  ConfigAreaKey,
  ConfigBlobArea,
  ConfigBlobItem,
  ConfigDecisions,
  ConfigDeployment,
  ConfigImportMode,
  ConfigMatchTier,
  ConfigPlan,
  ConfigPlanItem,
  ConfigPlanOp,
  ConfigSecretInput,
  ConfigSpec,
} from "@openwork/types/den/config-blobs"
import { CONFIG_BLOCKING_FLAGS, EMPTY_CONFIG_DECISIONS, parseConfigRef } from "@openwork/types/den/config-blobs"
import type { ConfigArea, ConfigAreaContext, ConfigItem } from "../area.js"
import { canonicalJsonPlain, specRev } from "./canonical.js"
import { classifyMatched, diffSpecs, type EngineFieldChange } from "./diff.js"
import { blobItemAsConfigItem, matchArea, type ItemMatch } from "./match.js"
import {
  createRefResolver,
  findRefs,
  localizeSpec,
  skippedKey,
  toPlanRef,
  type ResolvedRefOccurrence,
} from "./refs.js"
import { checkSecretFields, planSecrets, type ExecutionSecret } from "./secrets.js"
import { sha256 } from "./util.js"

export type BuildPlanInput = {
  /** Area definitions: every area in scope plus every area references may point to. */
  areas: readonly ConfigArea[]
  /** `flattenConfigAreas(blob.areas).areas`. */
  blobAreas: Partial<Record<ConfigAreaKey, ConfigBlobArea>>
  scope: readonly ConfigAreaKey[]
  mode: ConfigImportMode
  /** The target org's current items, per area (scope and referenced areas). */
  targetItems: ReadonlyMap<ConfigAreaKey, readonly ConfigItem[]>
  /** Alias rows for the blob's source instance: area → source id → local id. */
  aliases?: ReadonlyMap<ConfigAreaKey, ReadonlyMap<string, string>>
  decisions?: ConfigDecisions
  /** Secret inputs. Only their decisions are read; values never enter the plan. */
  secretInputs?: readonly ConfigSecretInput[]
  /** Target org members: normalized email → member id. */
  people?: ReadonlyMap<string, string>
  /** Operator allowlist for `env` secrets (self-hosted). Default: nothing allowed. */
  allowEnv?: (name: string) => boolean
  deployment: ConfigDeployment
  features: Partial<Record<FeatureKey, boolean>>
  sourceInstanceId?: string
  /**
   * The blob was exported from this same organization, so item `rev`s are a
   * valid three-way base. Otherwise revs are ignored (two-way diff).
   */
  sameOrganization?: boolean
  /** Specs at export, keyed `${area}/${source id}`: per-field base values for drifted items. */
  baseSpecs?: ReadonlyMap<string, ConfigSpec>
  /** Needed to run `protectedFromDelete`; without it, ticked deletes on areas that declare it are not planned. */
  ctx?: ConfigAreaContext
}

export type ExecutionItem = {
  /** Source id from the blob, if any. */
  sourceId?: string
  key?: string | null
  name: string
  /** As in the blob: `$ref`s and `$secret`s still unresolved (see `refs` / `secrets`). */
  spec: ConfigSpec
}

export type ExecutionOp = {
  area: ConfigAreaKey
  ref: string
  kind: "create" | "update" | "delete"
  /** The plan op (`rename` executes as an update). */
  op: ConfigPlanOp
  matchedBy: ConfigMatchTier | null
  targetId?: string
  /** Source id to reuse for a create when it is free on the instance (D4). */
  preferredId?: string
  item?: ExecutionItem
  refs: ResolvedRefOccurrence[]
  secrets: ExecutionSecret[]
  previous?: ConfigItem
}

export type ExecutionPlan = {
  planHash: string
  /** Items with blocking flags. `executePlan` refuses to run while non-zero. */
  blocking: number
  ops: ExecutionOp[]
}

export type BuildPlanResult = {
  plan: ConfigPlan
  execution: ExecutionPlan
  /** Validation errors (duplicate ids/keys, invalid specs, unknown areas, newer spec versions). */
  errors: string[]
  /**
   * The subset of `errors` that invalidates the whole request (unknown areas,
   * newer spec versions, duplicate ids/keys). Invalid item specs are not in
   * it: those items are `blocked` and the admin may skip them.
   */
  fatalErrors: string[]
}

/** Areas in dependency order (dependencies first, otherwise input order). Throws on a cycle. */
export function sortAreas<T extends Pick<ConfigArea, "key" | "dependsOn">>(areas: readonly T[]): T[] {
  const byKey = new Map(areas.map((area) => [area.key, area]))
  const sorted: T[] = []
  const state = new Map<ConfigAreaKey, "visiting" | "done">()
  const visit = (area: T, trail: ConfigAreaKey[]) => {
    const current = state.get(area.key)
    if (current === "done") return
    if (current === "visiting") throw new Error(`config areas have a dependency cycle: ${[...trail, area.key].join(" → ")}`)
    state.set(area.key, "visiting")
    for (const dependency of area.dependsOn) {
      const next = byKey.get(dependency)
      if (next && next.key !== area.key) visit(next, [...trail, area.key])
    }
    state.set(area.key, "done")
    sorted.push(area)
  }
  for (const area of areas) visit(area, [])
  return sorted
}

export function unsupportedReason(area: Pick<ConfigArea, "deployments" | "feature">, deployment: ConfigDeployment, features: Partial<Record<FeatureKey, boolean>>): string | null {
  if (!area.deployments.includes(deployment)) return `not available on ${deployment === "cloud" ? "cloud" : "self-hosted"} deployments`
  if (area.feature && !features[area.feature]) return `needs the ${area.feature} feature, which is off here`
  return null
}

type AreaState = {
  area: ConfigArea
  unsupported: string | null
  items: ConfigBlobItem[]
  /** Per blob item index: why it cannot be applied (invalid spec). */
  invalid: Map<number, string>
  match: { matches: ItemMatch[]; unmatchedTargets: ConfigItem[] } | null
}

type Draft = {
  item: ConfigPlanItem
  exec?: ExecutionOp
  oursRev?: string
  uniqueProbe?: ConfigItem
}

export function buildPlan(input: BuildPlanInput): BuildPlanResult {
  const decisions = input.decisions ?? EMPTY_CONFIG_DECISIONS
  const allowEnv = input.allowEnv ?? (() => false)
  const issues: ConfigPlan["issues"] = []
  const errors: string[] = []
  const fatalErrors: string[] = []
  const addError = (message: string, area?: ConfigAreaKey, options: { itemLevel?: boolean } = {}) => {
    errors.push(message)
    if (!options.itemLevel) fatalErrors.push(message)
    issues.push(area ? { level: "error", message, area } : { level: "error", message })
  }

  const ordered = sortAreas(input.areas)
  const areaByKey = new Map(ordered.map((area) => [area.key, area]))
  const scope = new Set(input.scope)
  for (const key of input.scope) if (!areaByKey.has(key)) addError(`area ${key} is not available on this server`, key)
  for (const key of Object.keys(input.blobAreas)) {
    if (!input.scope.some((scoped) => scoped === key)) issues.push({ level: "warning", message: `area ${key} is in the blob but not in its scope: ignored` })
  }
  if (input.mode === "merge" && decisions.deletes.length > 0) issues.push({ level: "warning", message: "deletes are ignored in merge mode" })

  // 1–3. Validate, upgrade and match each area in scope.
  const states: AreaState[] = []
  for (const area of ordered) {
    if (!scope.has(area.key)) continue
    const blobArea = input.blobAreas[area.key]
    const state: AreaState = { area, unsupported: unsupportedReason(area, input.deployment, input.features), items: [], invalid: new Map(), match: null }
    states.push(state)
    if (!blobArea) {
      issues.push({ level: "info", message: `${area.label}: in scope but not in the blob, treated as empty`, area: area.key })
      if (state.unsupported) continue
    } else {
      if (blobArea.specVersion > area.specVersion) {
        addError(`${area.label}: spec version ${blobArea.specVersion} is newer than this server supports (${area.specVersion})`, area.key)
        state.unsupported = `spec version ${blobArea.specVersion} is newer than this server supports`
      }
      state.items = blobArea.items.map((item, index) => {
        if (state.unsupported || blobArea.specVersion === area.specVersion) return item
        let spec = item.spec
        for (let version = blobArea.specVersion; version < area.specVersion; version += 1) {
          const upgrade = area.upgrade?.[version]
          if (!upgrade) {
            state.invalid.set(index, `no upgrade from spec version ${version}`)
            return item
          }
          spec = upgrade(spec)
        }
        return { ...item, spec }
      })
      if (state.unsupported) continue
      state.items.forEach((item, index) => {
        if (state.invalid.has(index)) return
        const parsed = area.specSchema.safeParse(item.spec)
        if (!parsed.success) {
          const message = parsed.error.issues.map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`).join("; ")
          state.invalid.set(index, message)
          addError(`${area.label} "${item.name}": ${message}`, area.key, { itemLevel: true })
        }
      })
    }
    if (state.unsupported) continue
    const matchResult = matchArea({
      area,
      blobItems: state.items,
      targetItems: input.targetItems.get(area.key) ?? [],
      aliases: input.aliases?.get(area.key),
      decisions: decisions.matches.filter((decision) => decision.area === area.key),
    })
    for (const error of matchResult.errors) addError(error, area.key)
    state.match = matchResult
  }

  // Skips: admin exclusions and unsupported areas.
  const skipped = new Set<string>()
  for (const skip of decisions.skips) skipped.add(skippedKey(skip.area, skip.ref))
  const blobMatches = new Map<ConfigAreaKey, readonly ItemMatch[]>()
  const writable = new Set<ConfigAreaKey>()
  for (const state of states) {
    if (state.match) {
      blobMatches.set(state.area.key, state.match.matches)
      writable.add(state.area.key)
    }
  }

  // Mirror deletes, decided before refs and collisions look at the target.
  const deleteTicks = new Set(decisions.deletes.map((entry) => `${entry.area}\u0000${entry.targetId}`))
  const deleting = new Map<ConfigAreaKey, Set<string>>()
  const targetOnly = new Map<ConfigAreaKey, Draft[]>()
  for (const state of states) {
    if (!state.match) continue
    const drafts: Draft[] = []
    const deletedIds = new Set<string>()
    for (const target of state.match.unmatchedTargets) {
      const item: ConfigPlanItem = {
        area: state.area.key,
        ref: `target:${target.id}`,
        op: "untouched",
        target: { id: target.id, key: target.key ?? null, name: target.name },
        matchedBy: null,
        flags: [],
        fields: [],
        targetRev: specRev(state.area, target.spec),
      }
      const draft: Draft = { item }
      if (input.mode === "merge") item.reasons = ["not in the blob"]
      else if (!deleteTicks.has(`${state.area.key}\u0000${target.id}`)) item.reasons = ["not in the blob — tick to delete"]
      else {
        const protection = state.area.protectedFromDelete
          ? input.ctx ? state.area.protectedFromDelete(target, input.ctx) : "protection could not be checked"
          : null
        if (protection) {
          item.reasons = [`cannot be deleted: ${protection}`]
          issues.push({ level: "warning", message: `${state.area.label} "${target.name}" cannot be deleted: ${protection}`, area: state.area.key })
        } else {
          item.op = "delete"
          item.flags.push("destructive")
          item.reasons = ["not in the blob — will be deleted"]
          deletedIds.add(target.id)
          draft.exec = { area: state.area.key, ref: item.ref, kind: "delete", op: "delete", matchedBy: null, targetId: target.id, refs: [], secrets: [], previous: target }
        }
      }
      drafts.push(draft)
    }
    deleting.set(state.area.key, deletedIds)
    targetOnly.set(state.area.key, drafts)
  }

  // 4–6. Resolve refs, diff, secrets.
  const resolveRef = createRefResolver({
    scope: writable,
    blobMatches,
    skipped,
    targetItems: input.targetItems,
    areas: areaByKey,
    aliases: input.aliases,
    people: input.people,
    decisions: decisions.refs,
  })
  const inputsByPath = new Map((input.secretInputs ?? []).map((secretInput) => [secretInput.path, secretInput]))
  const overrides = new Set(decisions.overrides.map((entry) => skippedKey(entry.area, entry.ref)))
  const renames = new Map(decisions.renames.map((entry) => [skippedKey(entry.area, entry.ref), entry.name]))

  const blobDrafts = new Map<ConfigAreaKey, Draft[]>()
  for (const state of states) {
    const { area } = state
    const drafts: Draft[] = []
    blobDrafts.set(area.key, drafts)
    if (!state.match) {
      state.items.forEach((blob, index) => {
        drafts.push({
          item: {
            area: area.key,
            ref: blobRefFor(blob, index),
            op: "skip",
            blob: blobSummary(blob),
            matchedBy: null,
            flags: [],
            reasons: [state.unsupported ?? "not supported"],
            fields: [],
          },
        })
      })
      continue
    }
    for (const match of state.match.matches) {
      const key = skippedKey(area.key, match.ref)
      const renamed = renames.get(key)
      const blob: ConfigBlobItem = renamed ? { ...match.blob, name: renamed } : match.blob
      const item: ConfigPlanItem = {
        area: area.key,
        ref: match.ref,
        op: "create",
        blob: blobSummary(blob),
        matchedBy: match.matchedBy,
        flags: [...match.flags],
        fields: [],
      }
      const reasons = [...match.reasons]
      if (renamed) reasons.push(`renamed to "${renamed}"`)
      if (match.candidates) item.candidates = match.candidates
      if (match.target) {
        item.target = { id: match.target.id, key: match.target.key ?? null, name: match.target.name }
        item.targetRev = specRev(area, match.target.spec)
      }
      const draft: Draft = { item, oursRev: specRev(area, blob.spec) }
      drafts.push(draft)

      if (skipped.has(key)) {
        item.op = "skip"
        item.flags = []
        item.reasons = [...reasons, "excluded from this import"]
        continue
      }

      const refs = findRefs(blob.spec).map((occurrence) => {
        const resolved = resolveRef(area.key, match.ref, occurrence)
        if (resolved.resolution.kind !== "target") return resolved
        const parsed = parseConfigRef(occurrence.ref)
        if (parsed && parsed.area !== "people" && deleting.get(parsed.area)?.has(resolved.resolution.id)) {
          return { ...resolved, resolution: { kind: "unresolved" as const, reason: `the referenced ${parsed.area} item is deleted by this import` } }
        }
        return resolved
      })
      const localized = localizeSpec(blob.spec, refs)
      let fields: EngineFieldChange[]
      if (match.target) {
        const classification = classifyMatched({
          area,
          blob,
          localizedSpec: localized,
          target: match.target,
          threeWay: input.sameOrganization === true,
          override: overrides.has(key),
          baseSpec: blob.id ? input.baseSpecs?.get(`${area.key}/${blob.id}`) : undefined,
        })
        item.op = classification.op
        fields = classification.fields
        item.flags.push(...classification.flags)
        reasons.push(...classification.reasons)
      } else {
        fields = diffSpecs(area, {}, localized)
      }
      item.fields = fields

      const writes = item.op === "create" || item.op === "update" || item.op === "rename"
      if (refs.length) item.refs = refs.map(toPlanRef)
      if (writes) {
        const unresolved = refs.filter((ref) => ref.resolution.kind === "unresolved")
        if (unresolved.length) {
          item.flags.push("ref_unresolved")
          for (const ref of unresolved) if (ref.resolution.kind === "unresolved") reasons.push(`${ref.path}: ${ref.resolution.reason}`)
        }
      }
      const invalid = state.invalid.get(match.index)
      if (invalid) {
        item.flags.push("blocked")
        reasons.push(`invalid: ${invalid}`)
      }
      const secretProblems = checkSecretFields(area.secretFields, blob.spec)
      if (secretProblems.undeclared.length || secretProblems.raw.length) {
        item.flags.push("blocked")
        for (const field of secretProblems.undeclared) reasons.push(`${field}: a secret placeholder is not allowed here`)
        for (const field of secretProblems.raw) reasons.push(`${field}: secrets are never accepted inside a blob; use a $secret placeholder and enter the value separately`)
      }
      const secrets = planSecrets({
        layout: area,
        blobSpec: blob.spec,
        targetSpec: match.target?.spec ?? null,
        inputs: inputsByPath,
        allowEnv,
        required: writes,
      })
      if (secrets.secrets.length) item.secrets = secrets.secrets
      item.flags.push(...secrets.flags)
      reasons.push(...secrets.reasons)
      if (writes && area.externalEffects) item.flags.push("external_effect")
      if (reasons.length) item.reasons = reasons

      if (writes) {
        const execItem: ExecutionItem = { name: blob.name, spec: blob.spec }
        if (blob.id) execItem.sourceId = blob.id
        if (blob.key !== undefined) execItem.key = blob.key
        draft.exec = match.target
          ? { area: area.key, ref: match.ref, kind: "update", op: item.op, matchedBy: match.matchedBy, targetId: match.target.id, item: execItem, refs, secrets: secrets.execution, previous: match.target }
          : { area: area.key, ref: match.ref, kind: "create", op: "create", matchedBy: match.matchedBy, item: execItem, refs, secrets: secrets.execution, ...(blob.id ? { preferredId: blob.id } : {}) }
        draft.uniqueProbe = { id: match.target?.id ?? blobItemAsConfigItem(blob, match.index).id, key: blob.key ?? match.target?.key ?? null, name: blob.name, spec: localized }
      }
    }
  }

  // Unique collisions: every writing item against the target as it will be.
  for (const state of states) {
    if (!state.match || !state.area.uniqueFields?.length) continue
    const drafts = blobDrafts.get(state.area.key) ?? []
    const rewritten = new Set(drafts.flatMap((draft) => (draft.uniqueProbe && draft.item.target ? [draft.item.target.id] : [])))
    const deletedIds = deleting.get(state.area.key) ?? new Set<string>()
    const staying = (input.targetItems.get(state.area.key) ?? []).filter((item) => !rewritten.has(item.id) && !deletedIds.has(item.id))
    for (const unique of state.area.uniqueFields) {
      const counts = new Map<string, number>()
      const bump = (value: string | null) => {
        if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1)
      }
      for (const item of staying) bump(unique.get(item))
      for (const draft of drafts) if (draft.uniqueProbe) bump(unique.get(draft.uniqueProbe))
      for (const draft of drafts) {
        if (!draft.uniqueProbe) continue
        const value = unique.get(draft.uniqueProbe)
        if (value === null || (counts.get(value) ?? 0) < 2) continue
        if (!draft.item.flags.includes("collision.unique")) draft.item.flags.push("collision.unique")
        draft.item.reasons = [...(draft.item.reasons ?? []), `another item already has ${unique.label} "${value}": rename this one, match it to the existing item, or skip it`]
      }
    }
  }

  // 7. Assemble.
  const planAreas: ConfigPlan["areas"] = []
  const forward: ExecutionOp[] = []
  const deletes: ExecutionOp[][] = []
  const hashItems: unknown[] = []
  for (const state of states) {
    const drafts = [...(blobDrafts.get(state.area.key) ?? []), ...(targetOnly.get(state.area.key) ?? [])]
    const areaDeletes: ExecutionOp[] = []
    for (const draft of drafts) {
      draft.item.flags = [...new Set(draft.item.flags)]
      if (draft.exec?.kind === "delete") areaDeletes.push(draft.exec)
      else if (draft.exec) forward.push(draft.exec)
      hashItems.push(hashView(draft))
    }
    deletes.unshift(areaDeletes)
    planAreas.push({ area: state.area.key, label: state.area.label, items: drafts.map((draft) => draft.item) })
  }

  const summary: ConfigPlan["summary"] = { create: 0, update: 0, rename: 0, unchanged: 0, delete: 0, untouched: 0, skip: 0, blocking: 0 }
  for (const area of planAreas) {
    for (const item of area.items) {
      summary[item.op] += 1
      if (item.flags.some((flag) => CONFIG_BLOCKING_FLAGS.includes(flag))) summary.blocking += 1
    }
  }

  const planHash = sha256(canonicalJsonPlain({
    mode: input.mode,
    sourceInstanceId: input.sourceInstanceId ?? null,
    items: hashItems,
    decisions,
    secretDecisions: (input.secretInputs ?? []).map((secretInput) => ({ path: secretInput.path, decision: secretInput.decision, env: secretInput.decision === "env" ? secretInput.env : null })),
    issues: issues.map((issue) => `${issue.level}:${issue.area ?? ""}:${issue.message}`),
  }))

  const plan: ConfigPlan = { planHash, mode: input.mode, summary, areas: planAreas, issues }
  const execution: ExecutionPlan = { planHash, blocking: summary.blocking, ops: [...forward, ...deletes.flat()] }
  return { plan, execution, errors, fatalErrors }
}

function blobRefFor(blob: ConfigBlobItem, index: number): string {
  return blob.id ? blob.id : blob.key ? `key:${blob.key}` : `#${index}`
}

function blobSummary(blob: ConfigBlobItem): NonNullable<ConfigPlanItem["blob"]> {
  const out: NonNullable<ConfigPlanItem["blob"]> = { name: blob.name }
  if (blob.id) out.id = blob.id
  if (blob.key !== undefined) out.key = blob.key
  return out
}

/** What of an item the plan hash covers: ops, matches, target revs, resolutions and secret decision kinds. Never values. */
function hashView(draft: Draft): unknown {
  const { item } = draft
  return {
    area: item.area,
    ref: item.ref,
    op: item.op,
    matchedBy: item.matchedBy,
    blob: item.blob ?? null,
    targetId: item.target?.id ?? null,
    // Name and key live outside the spec: a rename on the target is drift too.
    targetName: item.target?.name ?? null,
    targetKey: item.target?.key ?? null,
    targetRev: item.targetRev ?? null,
    oursRev: draft.oursRev ?? null,
    flags: item.flags,
    refs: (item.refs ?? []).map((ref) => ({ path: ref.path, ref: ref.ref, resolvedId: ref.resolvedId, via: ref.via, decision: ref.decision ?? null })),
    secrets: (item.secrets ?? []).map((secret) => ({ path: secret.path, decision: secret.decision, env: secret.env ?? null })),
  }
}
