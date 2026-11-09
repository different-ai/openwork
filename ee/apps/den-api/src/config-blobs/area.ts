/**
 * The contract every config-blob area adapter implements. Adapters live in
 * `./areas/<area-key>.ts` and are registered in `./registry.ts`.
 *
 * Adapters only know their own area: how to serialize it (allowlist, never row
 * dumps, no secrets), how to recognise "the same item" by natural key, and how
 * to apply a create / update / delete through the EXISTING domain services so
 * validation, permission rules, audit capture and side effects stay identical
 * to the UI. Matching, diffing, reference resolution, hashing and queueing are
 * the engine's job (`./engine/*`), never an adapter's.
 *
 * Design: docs/features/config-blobs/.
 */
import type { FeatureKey, FeatureMap } from "@openwork/features"
import type { PermissionKey } from "@openwork/types/den/permissions"
import type {
  ConfigApplyFailure,
  ConfigApplyStep,
  ConfigAreaKey,
  ConfigDeployment,
  ConfigFieldChange,
  ConfigSpec,
} from "@openwork/types/den/config-blobs"
import type { z } from "zod"
import type { db as denDb } from "../db.js"

export type ConfigDb = typeof denDb

export type ConfigActor = {
  userId: string
  /** Org membership id (`om_…`) of the person (or API key's issuing member) acting. */
  memberId: string
}

export type ConfigAreaContext = {
  db: ConfigDb
  organizationId: string
  actor: ConfigActor
  deployment: ConfigDeployment
  features: FeatureMap
}

/**
 * One item as an adapter exports it, and as the engine compares it.
 *
 * - `spec` is the portable, editable part. References to other items are
 *   `{ $ref: "<area>/<id>", name }` (people: `{ $ref: "people/<email>" }`).
 *   Secret fields are `{ $secret: "<area>/<id>/<field path>", set: boolean }`.
 * - Nested child rows (models, entries…) stay inside `spec` as arrays of
 *   objects that carry their own `id`; declare their keys in `arrayKeys`.
 */
export type ConfigItem = {
  id: string
  key?: string | null
  name: string
  spec: ConfigSpec
}

/**
 * The item handed to `apply`: the blob's spec after the engine resolved it.
 * - every `$ref` object has an added `id` with the LOCAL target id
 *   (refs the admin chose to drop are removed from their array);
 * - every `$secret` object is a `ResolvedConfigSecret`
 *   (`{decision:"keep"}` | `{decision:"value", value}` | `{decision:"unset"}`).
 */
export type ResolvedConfigItem = {
  /** Source id from the blob, if any. */
  sourceId?: string
  key?: string | null
  name: string
  spec: ConfigSpec
}

export type ConfigApplyOp =
  | {
      kind: "create"
      item: ResolvedConfigItem
      /** Reuse this id for the new row when the adapter can (it is free on the whole instance). */
      preferredId?: string
    }
  | {
      kind: "update"
      targetId: string
      item: ResolvedConfigItem
      previous: ConfigItem
      /**
       * Field-level changes between `previous` and `item` (from the plan), plus
       * `secretPaths` whose placeholder carries a new value. Adapters MUST write
       * only what these name: untouched children, grants and settings are not
       * rewritten. An update with no changes and no secret values is never sent.
       */
      changes: ConfigFieldChange[]
      secretPaths: string[]
    }
  | { kind: "delete"; targetId: string; previous: ConfigItem }

export type ConfigApplyResult = {
  /** Local id of the created / updated row (for alias rows and later refs). */
  localId: string
  warnings?: string[]
  /** Writes performed, in order (shown in the apply report). Empty means nothing was written (noop). */
  steps?: ConfigApplyStep[]
}

/**
 * Throw this from `apply` to report where an item failed. `stepsDone` are the
 * writes that already happened for this item before the failure, so the report
 * can say exactly what was left half-written.
 */
export class ConfigApplyItemError extends Error {
  readonly failure: ConfigApplyFailure
  readonly stepsDone: ConfigApplyStep[]
  constructor(failure: ConfigApplyFailure, stepsDone: ConfigApplyStep[] = []) {
    super(failure.message)
    this.name = "ConfigApplyItemError"
    this.failure = failure
    this.stepsDone = stepsDone
  }
}

export type ConfigNaturalKey = {
  /** Shown to admins as "matched by <label>". */
  label: string
  /** Normalised value, or null when the item has none. Only used when unique on BOTH sides. */
  get: (item: ConfigItem) => string | null
}

export type ConfigSimilarity = (blob: ConfigItem, target: ConfigItem) => { score: number; reasons: string[] }

export type ConfigArea = {
  key: ConfigAreaKey
  label: string
  /**
   * TypeID prefix of this area's item ids (`ipr`, `tem`…). A create only
   * reuses a source id with this prefix (D4). Without it, the prefix the
   * target's items share is used; with neither, no source id is reused.
   */
  idPrefix?: string
  /** Sidebar breadcrumb, e.g. ["AI Gateway", "AI Providers"]. */
  path: string[]
  specVersion: number
  /** Strict Zod schema for `spec` (refs/secrets included as their placeholder shapes). */
  specSchema: z.ZodType<ConfigSpec>
  /** Areas this one references; the engine applies in topological order. */
  dependsOn: ConfigAreaKey[]
  deployments: readonly ConfigDeployment[]
  /** Feature that must be on for the area to be supported. */
  feature?: FeatureKey
  viewPermission: PermissionKey
  managePermission: PermissionKey
  /** SQL table names whose config this area owns (coverage check). */
  tables: string[]
  naturalKeys: ConfigNaturalKey[]
  similarity?: ConfigSimilarity
  /** Spec paths holding `$secret` placeholders, e.g. "credentials.apiKey", "headers[].value". */
  secretFields: string[]
  /** True when spec contains confidential (encrypted-at-rest) content such as skill bodies or prompts. */
  containsConfidentialContent?: boolean
  /**
   * Arrays whose element order is meaningful. All other arrays are treated as
   * sets: canonicalised by `arrayKeys[path]` (default `id`, then `$ref`, then JSON).
   * Paths use `[]` for array elements: "models", "entries[].limits".
   */
  orderedArrays?: string[]
  arrayKeys?: Record<string, string>
  /**
   * Spec fields exported for people reading the blob that an import never
   * changes (e.g. a person's `status`: an import can invite, not make someone
   * join). Left out of diffs and hashes, so they never make an item differ.
   */
  informationalFields?: string[]
  /** The item's name is derived on the target and never set by import (people): a different name is not a change. */
  informationalName?: boolean
  /** Fields in `spec` that, when they are the only change besides name/key, still count as a rename. Rarely needed. */
  cosmeticFields?: string[]
  /** Unique constraints on the target that a create/rename could break, e.g. team name. */
  uniqueFields?: Array<{ label: string; get: (item: ConfigItem | ResolvedConfigItem) => string | null }>
  /**
   * Whether `apply` writes only through `ctx.db` (so the engine may pass a transaction).
   * False when it calls services that use the global db or make external calls.
   */
  transactional: boolean
  /** Whether apply calls out to the network (MCP probe, OAuth discovery…). */
  externalEffects?: boolean
  /** Items the engine must never delete (e.g. built-in roles, the applier themself). */
  protectedFromDelete?: (item: ConfigItem, ctx: ConfigAreaContext) => string | null
  /**
   * Effects of this op that a later revert cannot undo, in plain words for admins
   * ("Invitation email sent to ada@example.com", "Members' sign-ins to this
   * connector are revoked", "The stored API key is deleted and must be re-entered").
   * Shown on the plan before approval and in the apply report.
   */
  irreversible?: (op: ConfigApplyOp) => string[]
  exportItems(ctx: ConfigAreaContext): Promise<ConfigItem[]>
  /**
   * Read only these items (by local id). Used by apply to re-check drift and to
   * snapshot just the items about to be written, instead of exporting the area.
   * Missing ids are simply absent from the result. Defaults to filtering exportItems.
   */
  readItems?(ctx: ConfigAreaContext, ids: string[]): Promise<ConfigItem[]>
  apply(ctx: ConfigAreaContext, op: ConfigApplyOp): Promise<ConfigApplyResult>
  /** Upgraders from older specVersions: `upgrade[1]` turns a v1 spec into v2. */
  upgrade?: Record<number, (spec: ConfigSpec) => ConfigSpec>
}

export function defineConfigArea(area: ConfigArea): ConfigArea {
  return area
}
