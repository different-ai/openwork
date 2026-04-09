import { DateTime } from "luxon"
import { TypeID, typeid } from "typeid-js"
import { v7 as uuidv7 } from "uuid"
import { z } from "zod"

export const TYPE_ID_SUFFIX_LENGTH = 26

const BASE32_REGEX = /^[0-9a-hjkmnp-tv-z]+$/

export const idTypesMapNameToPrefix = {
  request: "req",
  user: "usr",
  session: "ses",
  account: "acc",
  verification: "ver",
  apiKey: "apk",
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
  llmProvider: "lpr",
  llmProviderModel: "lpm",
  llmProviderAccess: "lpa",
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

export const denTypeIdPrefixes = idTypesMapNameToPrefix

type IdTypesMapNameToPrefix = typeof idTypesMapNameToPrefix
type IdTypesMapPrefixToName = {
  [K in keyof IdTypesMapNameToPrefix as IdTypesMapNameToPrefix[K]]: K
}

const idTypesMapPrefixToName = Object.fromEntries(
  Object.entries(idTypesMapNameToPrefix).map(([name, prefix]) => [prefix, name]),
) as IdTypesMapPrefixToName

export type IdTypePrefixNames = keyof typeof idTypesMapNameToPrefix
export type DenTypeIdName = IdTypePrefixNames
export type TypeId<T extends IdTypePrefixNames> = `${IdTypesMapNameToPrefix[T]}_${string}`
export type DenTypeId<TName extends DenTypeIdName> = TypeId<TName>

type TypeIdSchema<T extends IdTypePrefixNames> = z.ZodType<TypeId<T>, string>

const schemaCache = new Map<IdTypePrefixNames, z.ZodType<string, string>>()

const buildTypeIdSchema = <const T extends IdTypePrefixNames>(prefix: T): TypeIdSchema<T> => {
  const expectedPrefix = idTypesMapNameToPrefix[prefix]
  const expectedLength = TYPE_ID_SUFFIX_LENGTH + expectedPrefix.length + 1

  return z
    .string()
    .length(expectedLength, {
      message: `TypeID must be ${expectedLength} characters (${expectedPrefix}_<26 char suffix>)`,
    })
    .startsWith(`${expectedPrefix}_`, {
      message: `TypeID must start with '${expectedPrefix}_'`,
    })
    .refine(
      (input) => {
        const suffix = input.slice(expectedPrefix.length + 1)
        return BASE32_REGEX.test(suffix)
      },
      { message: "TypeID suffix contains invalid base32 characters" },
    )
    .refine(
      (input) => {
        try {
          TypeID.fromString(input)
          return true
        } catch {
          return false
        }
      },
      { message: "TypeID is structurally invalid" },
    )
    .transform((input) => TypeID.fromString(input).toString() as TypeId<T>)
}

const typeIdZodSchema = <const T extends IdTypePrefixNames>(prefix: T): TypeIdSchema<T> => {
  let schema = schemaCache.get(prefix)
  if (!schema) {
    schema = buildTypeIdSchema(prefix)
    schemaCache.set(prefix, schema)
  }
  return schema as TypeIdSchema<T>
}

const typeIdGenerator = <const T extends IdTypePrefixNames>(
  prefix: T,
) => typeid(idTypesMapNameToPrefix[prefix]).toString() as TypeId<T>

const validateTypeId = <const T extends IdTypePrefixNames>(
  prefix: T,
  data: unknown,
): data is TypeId<T> => typeIdZodSchema(prefix).safeParse(data).success

const inferTypeId = <T extends keyof IdTypesMapPrefixToName>(
  input: `${T}_${string}`,
): IdTypesMapPrefixToName[T] => {
  const parsed = TypeID.fromString(input)
  const prefix = parsed.getType() as T
  const typeName = idTypesMapPrefixToName[prefix]

  if (typeName === undefined) {
    throw new Error(
      `Unknown TypeID prefix '${prefix}'. Registered prefixes: ${Object.keys(idTypesMapPrefixToName).join(", ")}`,
    )
  }

  return typeName
}

const typeIdFromString = <const T extends IdTypePrefixNames>(
  typeName: T,
  input: string,
): TypeId<T> => {
  const parsed = TypeID.fromString(input)
  const expectedPrefix = idTypesMapNameToPrefix[typeName]
  const actualPrefix = parsed.getType()

  if (actualPrefix !== expectedPrefix) {
    throw new Error(
      `TypeID prefix mismatch: expected '${expectedPrefix}' but got '${actualPrefix}'`,
    )
  }

  return parsed.toString() as TypeId<T>
}

const typeIdWithTimestamp = <const T extends IdTypePrefixNames>(
  typeName: T,
  timestamp?: Date | number,
): TypeId<T> => {
  let msecs: number

  if (timestamp === undefined) {
    msecs = DateTime.now().toMillis()
  } else if (timestamp instanceof Date) {
    msecs = timestamp.getTime()
  } else {
    msecs = timestamp
  }

  if (!Number.isFinite(msecs)) {
    throw new Error(`Invalid timestamp: expected finite number, got ${msecs}`)
  }
  if (msecs < 0) {
    throw new Error(`Invalid timestamp: expected non-negative number, got ${msecs}`)
  }

  const uuid = uuidv7({ msecs })
  const prefix = idTypesMapNameToPrefix[typeName]
  return TypeID.fromUUID(prefix, uuid).toString() as TypeId<T>
}

const getColumnLength = <const T extends IdTypePrefixNames>(typeName: T) =>
  idTypesMapNameToPrefix[typeName].length + 1 + TYPE_ID_SUFFIX_LENGTH

export const typeId = {
  schema: typeIdZodSchema,
  generator: typeIdGenerator,
  generatorWithTimestamp: typeIdWithTimestamp,
  validator: validateTypeId,
  infer: inferTypeId,
  fromString: typeIdFromString,
  suffixLength: TYPE_ID_SUFFIX_LENGTH,
  prefix: idTypesMapNameToPrefix,
  columnLength: getColumnLength,
}

export function createDenTypeId<TName extends DenTypeIdName>(name: TName): DenTypeId<TName> {
  return typeId.generator(name)
}

export function normalizeDenTypeId<TName extends DenTypeIdName>(
  name: TName,
  value: string,
): DenTypeId<TName> {
  return typeId.fromString(name, value)
}

export function isDenTypeId<TName extends DenTypeIdName>(
  name: TName,
  value: unknown,
): value is DenTypeId<TName> {
  return typeId.validator(name, value)
}
