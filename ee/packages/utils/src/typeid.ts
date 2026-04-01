import { fromString, getType, typeid } from "typeid-js"

export const denTypeIdPrefixes = {
  request: "req",
  user: "usr",
  session: "ses",
  account: "acc",
  verification: "ver",
  rateLimit: "rli",
  org: "org",
  organization: "org",
  orgMembership: "om",
  member: "om",
  invitation: "inv",
  team: "tem",
  teamMember: "tmb",
  skill: "skl",
  skillHub: "shb",
  skillHubSkill: "shs",
  skillHubMember: "shm",
  organizationRole: "orl",
  tempTemplateSharing: "tts",
  adminAllowlist: "aal",
  worker: "wrk",
  workerInstance: "wki",
  daytonaSandbox: "dts",
  workerToken: "wkt",
  workerBundle: "wkb",
  auditEvent: "aev",
} as const

export type DenTypeIdName = keyof typeof denTypeIdPrefixes
export type DenTypeIdPrefix<TName extends DenTypeIdName> = (typeof denTypeIdPrefixes)[TName]
export type DenTypeId<TName extends DenTypeIdName> = `${DenTypeIdPrefix<TName>}_${string}`

export function createDenTypeId<TName extends DenTypeIdName>(name: TName): DenTypeId<TName> {
  return typeid(denTypeIdPrefixes[name]).toString() as DenTypeId<TName>
}

export function normalizeDenTypeId<TName extends DenTypeIdName>(
  name: TName,
  value: string,
): DenTypeId<TName> {
  const parsed = fromString(value)
  const expectedPrefix = denTypeIdPrefixes[name]

  if (getType(parsed) !== expectedPrefix) {
    throw new Error(`invalid_den_typeid_prefix:${name}:${getType(parsed)}`)
  }

  return parsed as DenTypeId<TName>
}

export function isDenTypeId<TName extends DenTypeIdName>(
  name: TName,
  value: unknown,
): value is DenTypeId<TName> {
  if (typeof value !== "string") {
    return false
  }

  try {
    normalizeDenTypeId(name, value)
    return true
  } catch {
    return false
  }
}
