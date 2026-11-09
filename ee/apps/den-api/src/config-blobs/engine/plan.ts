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
  ConfigFieldChange,
  ConfigImportMode,
  ConfigMatchTier,
  ConfigPlan,
  ConfigPlanItem,
  ConfigPlanOp,
  ConfigPlanRef,
  ConfigSecretInput,
  ConfigSpec,
} from "@openwork/types/den/config-blobs"
import {
  CONFIG_BLOB_MAX_ITEMS,
  CONFIG_BLOB_MAX_ITEMS_PER_AREA,
  CONFIG_BLOCKING_FLAGS,
  EMPTY_CONFIG_DECISIONS,
  findConfigShapeProblem,
  parseConfigRef,
} from "@openwork/types/den/config-blobs"
import type { ConfigApplyOp, ConfigArea, ConfigAreaContext, ConfigItem, ConfigPreflightResult } from "../area.js"
import { canonicalJsonPlain, itemRev } from "./canonical.js"
import { classifyMatched, diffSpecs, type EngineFieldChange } from "./diff.js"
import { blobItemAsConfigItem, matchArea, type ItemMatch } from "./match.js"
import {
  PEOPLE_AREA,
  createRefResolver,
  findRefs,
  inviteRef,
  localizeSpec,
  refArea,
  rewriteRefs,
  skippedKey,
  toPlanRef,
  type ResolvedRefOccurrence,
} from "./refs.js"
import { checkSecretFields, planSecrets, redactRawSecrets, replacesSecretValue, type ExecutionSecret } from "./secrets.js"
import { isPlainObject, sha256, typeIdPrefix } from "./util.js"


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
  /**
   * Areas the caller may view. References into any other area keep their
   * resolved id (execution needs it) but lose name hints in fields and refs,
   * and their resolution reasons are replaced by a generic one. Omitted:
   * every area is visible.
   */
  visibleAreas?: ReadonlySet<ConfigAreaKey>
  /**
   * The areas' `preflight` verdicts on the ops of an earlier build of this
   * same plan, keyed by `preflightKey(area, ref)` (see `runPreflight`):
   * `skip` plans the item as skipped (references to it resolve like an
   * admin's skip), `block` adds the `blocked` flag, warnings become reasons.
   */
  preflight?: ReadonlyMap<string, ConfigPreflightResult>
}

/** Key of a plan item in `BuildPlanInput.preflight`. */
export function preflightKey(area: ConfigAreaKey, ref: string): string {
  return skippedKey(area, ref)
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
  /** Display name for the apply report (the blob item's, else the target's). */
  name: string
  /** Updates: the plan's field changes (adapters write only these). Empty for creates and deletes. */
  changes: ConfigFieldChange[]
  /** Updates: spec paths (`field`) of the secret placeholders whose decision writes the credential (value, env, or unset of a stored one). */
  secretPaths: string[]
  /** `itemRev` of the target the op was planned against (updates, deletes): apply re-reads the item and compares. */
  targetRev?: string
  /** Effects a later restore can't undo, as the area describes them for this op (computed at plan time). */
  irreversible: string[]
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
   * newer spec versions, duplicate ids/keys, too many items, forbidden keys or
   * too deep nesting, secret values pasted into the blob). Invalid item specs
   * are not in it: those items are `blocked` and the admin may skip them.
   * Never holds a secret value.
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

  // Size caps: matching and diffing are at least linear per item, and
  // proposals per pair; a blob past these is refused outright.
  let totalItems = 0
  for (const blobArea of Object.values(input.blobAreas)) totalItems += blobArea?.items.length ?? 0
  const tooManyItems = totalItems > CONFIG_BLOB_MAX_ITEMS
  if (tooManyItems) addError(`the blob holds ${totalItems.toLocaleString("en-US")} items, more than the ${CONFIG_BLOB_MAX_ITEMS.toLocaleString("en-US")} allowed`)

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
      if (tooManyItems) {
        state.unsupported = "the blob holds too many items"
        continue
      }
      if (blobArea.items.length > CONFIG_BLOB_MAX_ITEMS_PER_AREA) {
        addError(`${area.label}: ${blobArea.items.length.toLocaleString("en-US")} items is more than the ${CONFIG_BLOB_MAX_ITEMS_PER_AREA.toLocaleString("en-US")} allowed in one area`, area.key)
        state.unsupported = "too many items in this area"
        continue
      }
      const shapeProblems = blobArea.items.flatMap((item, index) => {
        const problem = findConfigShapeProblem(item.spec, `${area.key}[${index}].spec`)
        return problem ? [`${area.label} "${item.name}": ${problem}`] : []
      })
      for (const problem of shapeProblems) addError(problem, area.key)
      if (shapeProblems.length > 0) {
        state.unsupported = "has a forbidden key or is nested too deeply"
        continue
      }
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
      // A value pasted into a secret field never goes further than this: it is
      // replaced before validation, diffing and hashing, and the request is invalid.
      state.items = state.items.map((item) => {
        const redaction = redactRawSecrets(area.secretFields, item.spec)
        for (const field of redaction.redacted) addError(`${area.label} "${item.name}": a secret value was pasted into ${field}; use the inputs step instead`, area.key)
        return redaction.redacted.length > 0 ? { ...item, spec: redaction.spec } : item
      })
      state.items.forEach((item, index) => {
        if (state.invalid.has(index)) return
        const parsed = area.specSchema.safeParse(item.spec)
        if (!parsed.success) {
          const message = parsed.error.issues.map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`).join("; ")
          state.invalid.set(index, message)
          addError(`${area.label} "${item.name}": ${message}`, area.key, { itemLevel: true })
          return
        }
        // The parsed spec: defaults the schema fills in (fields a hand-written blob may leave out) count as written.
        state.items[index] = { ...item, spec: parsed.data }
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
  const adminSkipped = new Set(skipped)
  const preflight = input.preflight ?? new Map<string, ConfigPreflightResult>()
  for (const [key, verdict] of preflight) if (verdict.skip) skipped.add(key)
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
        targetRev: itemRev(state.area, target),
      }
      const draft: Draft = { item }
      if (input.mode === "merge") item.reasons = ["not in the blob"]
      else if (!deleteTicks.has(`${state.area.key}\u0000${target.id}`)) item.reasons = ["not in the blob — tick to delete"]
      else {
        const protection = state.area.protectedFromDelete
          ? input.ctx ? state.area.protectedFromDelete(target, input.ctx) : "protection could not be checked"
          : null
        const verdict = preflight.get(preflightKey(state.area.key, item.ref))
        if (protection) {
          item.reasons = [`cannot be deleted: ${protection}`]
          issues.push({ level: "warning", message: `${state.area.label} "${target.name}" cannot be deleted: ${protection}`, area: state.area.key })
        } else if (verdict?.skip) {
          item.reasons = [`not deleted: ${verdict.skip}`]
        } else {
          item.op = "delete"
          item.flags.push("destructive")
          item.reasons = ["not in the blob — will be deleted"]
          deletedIds.add(target.id)
          draft.exec = { area: state.area.key, ref: item.ref, kind: "delete", op: "delete", matchedBy: null, targetId: target.id, refs: [], secrets: [], previous: target, name: target.name, changes: [], secretPaths: [], targetRev: item.targetRev, irreversible: [] }
          setIrreversible(state.area, item, draft.exec)
          applyVerdict(item, verdict)
        }
      }
      drafts.push(draft)
    }
    deleting.set(state.area.key, deletedIds)
    targetOnly.set(state.area.key, drafts)
  }

  // 4–6. Resolve refs, diff, secrets.
  const peopleArea = areaByKey.get(PEOPLE_AREA)
  const resolveRef = createRefResolver({
    scope: writable,
    blobMatches,
    skipped,
    targetItems: input.targetItems,
    areas: areaByKey,
    aliases: input.aliases,
    people: input.people,
    decisions: decisions.refs,
    canInvite: peopleArea !== undefined && unsupportedReason(peopleArea, input.deployment, input.features) === null,
  })
  const inputsByPath = new Map((input.secretInputs ?? []).map((secretInput) => [secretInput.path, secretInput]))
  const overrides = new Set(decisions.overrides.map((entry) => skippedKey(entry.area, entry.ref)))
  const renames = new Map(decisions.renames.map((entry) => [skippedKey(entry.area, entry.ref), entry.name]))

  // References into areas the caller can't view: ids stay, names and reasons go.
  const visibleAreas = input.visibleAreas
  const hiddenRef = (ref: string): boolean => {
    if (!visibleAreas) return false
    const area = refArea(ref)
    return area !== null && !visibleAreas.has(area)
  }
  const hideNames = (spec: ConfigSpec): ConfigSpec => {
    if (!visibleAreas) return spec
    const out = rewriteRefs(spec, (_path, ref) => (hiddenRef(ref.$ref) ? { $ref: ref.$ref } : ref))
    return isPlainObject(out) ? out : {}
  }

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
    // A create reuses its source id only when it looks like this area's ids (D4).
    const idPrefix = area.idPrefix ?? sharedTypeIdPrefix(input.targetItems.get(area.key) ?? [])
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
        item.targetRev = itemRev(area, match.target)
      }
      const draft: Draft = { item, oursRev: itemRev(area, blob) }
      drafts.push(draft)

      if (skipped.has(key)) {
        item.op = "skip"
        item.flags = []
        const automatic = adminSkipped.has(key) ? undefined : preflight.get(key)?.skip
        item.reasons = [...reasons, automatic ?? "excluded from this import"]
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
      const localizedView = hideNames(localized)
      let fields: EngineFieldChange[]
      if (match.target) {
        const baseSpec = blob.id ? input.baseSpecs?.get(`${area.key}/${blob.id}`) : undefined
        const classification = classifyMatched({
          area,
          blob,
          localizedSpec: localizedView,
          target: visibleAreas ? { ...match.target, spec: hideNames(match.target.spec) } : match.target,
          threeWay: input.sameOrganization === true,
          override: overrides.has(key),
          baseSpec: baseSpec ? hideNames(baseSpec) : undefined,
        })
        item.op = classification.op
        fields = classification.fields
        item.flags.push(...classification.flags)
        reasons.push(...classification.reasons)
        // A new credential is only stored by writing the item.
        if (item.op === "unchanged" && replacesSecretValue(area, blob.spec, inputsByPath)) {
          item.op = "update"
          reasons.push("credential will be replaced")
        }
      } else {
        fields = diffSpecs(area, {}, localizedView)
      }
      item.fields = fields

      const writes = item.op === "create" || item.op === "update" || item.op === "rename"
      if (refs.length) item.refs = refs.map((ref) => planRefView(toPlanRef(ref), hiddenRef(ref.ref)))
      if (writes) {
        const unresolved = refs.filter((ref) => ref.resolution.kind === "unresolved")
        if (unresolved.length) {
          item.flags.push("ref_unresolved")
          for (const ref of unresolved) {
            if (ref.resolution.kind !== "unresolved") continue
            reasons.push(hiddenRef(ref.ref) ? `${ref.path}: the reference could not be resolved` : `${ref.path}: ${ref.resolution.reason}`)
          }
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
        for (const field of secretProblems.raw) reasons.push(`${field}: a secret value was pasted here; use a $secret placeholder and enter the value in the inputs step`)
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
        const preferredId = blob.id && idPrefix !== null && typeIdPrefix(blob.id) === idPrefix ? blob.id : undefined
        const secretPaths = secrets.secrets
          .filter((secret) => secret.decision === "value" || secret.decision === "env" || (secret.decision === "unset" && secret.targetHasValue))
          // Spec paths (`credentialSets[id=…].credential`), as adapters compare them with `changes`; never the `$secret` handle.
          .map((secret) => secret.field)
        draft.exec = match.target
          ? { area: area.key, ref: match.ref, kind: "update", op: item.op, matchedBy: match.matchedBy, targetId: match.target.id, item: execItem, refs, secrets: secrets.execution, previous: match.target, name: blob.name, changes: fields, secretPaths, targetRev: item.targetRev, irreversible: [] }
          : { area: area.key, ref: match.ref, kind: "create", op: "create", matchedBy: match.matchedBy, item: execItem, refs, secrets: secrets.execution, name: blob.name, changes: [], secretPaths: [], irreversible: [], ...(preferredId ? { preferredId } : {}) }
        setIrreversible(area, item, draft.exec)
        applyVerdict(item, preflight.get(key))
        draft.uniqueProbe = { id: match.target?.id ?? blobItemAsConfigItem(blob, match.index).id, key: blob.key ?? match.target?.key ?? null, name: blob.name, spec: localized }
      }
    }
  }

  // Invite decisions for people who are neither members nor in the blob: one
  // planned `members.people` create each (pending invitation, role member, no
  // teams), run before everything else so references resolve to it.
  const inviteDrafts: Draft[] = []
  const invited = new Set<string>()
  for (const drafts of blobDrafts.values()) {
    for (const draft of drafts) {
      for (const ref of draft.exec?.refs ?? []) {
        if (ref.resolution.kind === "invite") invited.add(ref.resolution.email)
      }
    }
  }
  if (peopleArea) {
    for (const email of invited) {
      const spec: ConfigSpec = { email, role: "member", status: "invited", teams: [], managedBy: "manual" }
      const ref = inviteRef(email)
      const item: ConfigPlanItem = {
        area: PEOPLE_AREA,
        ref,
        op: "create",
        blob: { name: email },
        matchedBy: null,
        flags: peopleArea.externalEffects ? ["external_effect"] : [],
        reasons: ["invited because a reference chose to invite this person"],
        fields: diffSpecs(peopleArea, {}, spec),
      }
      const draft: Draft = { item, oursRev: itemRev(peopleArea, { name: email, spec }) }
      if (!peopleArea.specSchema.safeParse(spec).success) {
        item.flags.push("blocked")
        item.reasons = [`${email} is not a valid email address, so they can't be invited`]
      } else {
        draft.exec = { area: PEOPLE_AREA, ref, kind: "create", op: "create", matchedBy: null, item: { name: email, spec }, refs: [], secrets: [], name: email, changes: [], secretPaths: [], irreversible: [] }
        setIrreversible(peopleArea, item, draft.exec)
        // An invite other items rely on can't just be skipped: a skip verdict blocks it instead.
        const verdict = preflight.get(preflightKey(PEOPLE_AREA, ref))
        applyVerdict(item, verdict?.skip ? { ...verdict, block: verdict.block ?? verdict.skip } : verdict)
      }
      inviteDrafts.push(draft)
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
  for (const draft of inviteDrafts) {
    if (draft.exec) forward.push(draft.exec)
    hashItems.push(hashView(draft))
  }
  const peopleInScope = states.some((state) => state.area.key === PEOPLE_AREA)
  if (inviteDrafts.length > 0 && !peopleInScope && peopleArea) {
    planAreas.push({ area: PEOPLE_AREA, label: peopleArea.label, items: inviteDrafts.map((draft) => draft.item) })
  }
  for (const state of states) {
    const invites = state.area.key === PEOPLE_AREA ? inviteDrafts : []
    const drafts = [...(blobDrafts.get(state.area.key) ?? []), ...(targetOnly.get(state.area.key) ?? [])]
    const areaDeletes: ExecutionOp[] = []
    for (const draft of drafts) {
      draft.item.flags = [...new Set(draft.item.flags)]
      if (draft.exec?.kind === "delete") areaDeletes.push(draft.exec)
      else if (draft.exec) forward.push(draft.exec)
      hashItems.push(hashView(draft))
    }
    deletes.unshift(areaDeletes)
    planAreas.push({ area: state.area.key, label: state.area.label, items: [...invites, ...drafts].map((draft) => draft.item) })
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

/**
 * What the area says a later restore can't undo for this op, on the plan item
 * (shown before approval) and the execution op (seeded into the report). The
 * preview op carries the blob's spec with refs and secrets still unresolved.
 */
function setIrreversible(area: ConfigArea, item: ConfigPlanItem, exec: ExecutionOp): void {
  if (!area.irreversible) return
  const preview = previewOp(exec)
  if (!preview) return
  let effects: string[] = []
  try {
    effects = area.irreversible(preview)
  } catch {
    effects = []
  }
  exec.irreversible = effects
  if (effects.length > 0) item.irreversible = effects
}

/**
 * An execution op as the adapter's `apply` would get it, for plan-time
 * checks (`irreversible`, `preflight`): the blob's spec with `$ref`s and
 * `$secret`s still unresolved.
 */
export function previewOp(exec: ExecutionOp): ConfigApplyOp | null {
  if (exec.kind === "delete" && exec.targetId && exec.previous) return { kind: "delete", targetId: exec.targetId, previous: exec.previous }
  if (exec.kind === "update" && exec.targetId && exec.previous && exec.item) {
    return { kind: "update", targetId: exec.targetId, previous: exec.previous, item: { ...exec.item }, changes: exec.changes, secretPaths: exec.secretPaths }
  }
  if (exec.kind === "create" && exec.item) return { kind: "create", item: { ...exec.item } }
  return null
}

/** A preflight `block` (the `blocked` flag and its reason) and warnings on a planned write. */
function applyVerdict(item: ConfigPlanItem, verdict: ConfigPreflightResult | undefined): void {
  if (!verdict) return
  const reasons = [...(item.reasons ?? [])]
  if (verdict.block) {
    item.flags.push("blocked")
    reasons.push(verdict.block)
  }
  for (const warning of verdict.warnings ?? []) reasons.push(`warning: ${warning}`)
  if (reasons.length > 0) item.reasons = reasons
}

/** The TypeID prefix every item shares, or null when they have none in common (or there are none). */
function sharedTypeIdPrefix(items: readonly ConfigItem[]): string | null {
  let shared: string | null = null
  for (const item of items) {
    const prefix = typeIdPrefix(item.id)
    if (prefix === null || (shared !== null && prefix !== shared)) return null
    shared = prefix
  }
  return shared
}

/** A plan ref as the caller sees it: for areas they can't view, no name hint. */
function planRefView(ref: ConfigPlanRef, hidden: boolean): ConfigPlanRef {
  if (!hidden || ref.name === undefined) return ref
  const out: ConfigPlanRef = { path: ref.path, ref: ref.ref, resolvedId: ref.resolvedId, via: ref.via }
  if (ref.decision !== undefined) out.decision = ref.decision
  return out
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
