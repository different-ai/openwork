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
  memberId: string
  apiKeyId?: string | null
}

export type ConfigAreaContext = {
  db: ConfigDb
  organizationId: string
  actor: ConfigActor
  deployment: ConfigDeployment
  features: FeatureMap
}

export type ConfigItem = {
  id: string
  key?: string | null
  name: string
  spec: ConfigSpec
}

export type ResolvedConfigItem = {
  sourceId?: string
  key?: string | null
  name: string
  spec: ConfigSpec
}

export type ConfigApplyOp =
  | {
      kind: "create"
      item: ResolvedConfigItem
      preferredId?: string
    }
  | {
      kind: "update"
      targetId: string
      item: ResolvedConfigItem
      previous: ConfigItem
      changes: ConfigFieldChange[]
      secretPaths: string[]
    }
  | { kind: "delete"; targetId: string; previous: ConfigItem }

export type ConfigApplyResult = {
  localId: string
  warnings?: string[]
  steps?: ConfigApplyStep[]
}

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
  label: string
  get: (item: ConfigItem) => string | null
}

export type ConfigPreflightInfo = {
  secrets: ReadonlyArray<{ path: string; field: string; decision: "keep" | "env" | "value" | "unset" }>
  refs?: ReadonlyArray<{ path: string; ref: string; resolution: "target" | "planned" | "invite" | "drop" | "unresolved"; id?: string }>
}

export type ConfigPreflightResult = { skip?: string; block?: string; warnings?: string[] }

export type ConfigSimilarity = (blob: ConfigItem, target: ConfigItem) => { score: number; reasons: string[] }

export type ConfigArea = {
  key: ConfigAreaKey
  label: string
  idPrefix?: string
  path: string[]
  specVersion: number
  specSchema: z.ZodType<ConfigSpec>
  dependsOn: ConfigAreaKey[]
  deployments: readonly ConfigDeployment[]
  feature?: FeatureKey
  viewPermission: PermissionKey
  managePermission: PermissionKey
  tables: string[]
  naturalKeys: ConfigNaturalKey[]
  assignedKeys?: boolean
  identityOnly?: (item: ConfigItem) => boolean
  similarity?: ConfigSimilarity
  secretFields: string[]
  redactCredentials?: (spec: ConfigSpec) => { spec: ConfigSpec; problems: string[] }
  containsConfidentialContent?: boolean
  orderedArrays?: string[]
  arrayKeys?: Record<string, string>
  informationalFields?: string[]
  derivedFields?: string[]
  requiredRefs?: string[]
  informationalName?: boolean
  comparableSpec?: (spec: ConfigSpec) => ConfigSpec
  cosmeticFields?: string[]
  uniqueFields?: Array<{ label: string; get: (item: ConfigItem | ResolvedConfigItem) => string | null }>
  uniqueAmongCreates?: Array<{ label: string; get: (item: ConfigItem | ResolvedConfigItem) => string | null }>
  transactional: boolean
  externalEffects?: boolean
  protectedFromDelete?: (item: ConfigItem, ctx: ConfigAreaContext) => string | null
  irreversible?: (op: ConfigApplyOp) => string[]
  preflight?(ctx: ConfigAreaContext, op: ConfigApplyOp, info: ConfigPreflightInfo): Promise<ConfigPreflightResult | null>
  exportItems(ctx: ConfigAreaContext): Promise<ConfigItem[]>
  ensureKeys?(ctx: ConfigAreaContext, items: ConfigItem[]): Promise<ConfigItem[]>
  readItems?(ctx: ConfigAreaContext, ids: string[]): Promise<ConfigItem[]>
  apply(ctx: ConfigAreaContext, op: ConfigApplyOp): Promise<ConfigApplyResult>
  upgrade?: Record<number, (spec: ConfigSpec) => ConfigSpec>
}

export function defineConfigArea(area: ConfigArea): ConfigArea {
  return area
}
