import * as crypto from "node:crypto"
import { customType, timestamp, varchar } from "drizzle-orm/mysql-core"
import {
  type DenTypeId,
  type DenTypeIdName,
  normalizeDenTypeId,
  normalizeDenTypeIdOrLegacyUuid,
} from "@openwork-ee/utils/typeid"
import { sql } from "drizzle-orm"

const INTERNAL_ID_LENGTH = 64
const AUTH_EXTERNAL_ID_LENGTH = 36
const ENCRYPTION_VERSION_PREFIX = "enc:v1:"
const ENCRYPTION_ALGORITHM = "aes-256-gcm"
const MIN_ENCRYPTION_KEY_LENGTH = 32

export const authExternalIdColumn = (columnName: string) =>
  varchar(columnName, { length: AUTH_EXTERNAL_ID_LENGTH })

function getDatabaseEncryptionSecret() {
  const explicit = process.env.DEN_DB_ENCRYPTION_KEY?.trim()
  if (!explicit) {
    throw new Error(
      "DEN_DB_ENCRYPTION_KEY is required to use encrypted database columns",
    )
  }

  if (explicit.length < MIN_ENCRYPTION_KEY_LENGTH) {
    throw new Error(
      `DEN_DB_ENCRYPTION_KEY must be at least ${MIN_ENCRYPTION_KEY_LENGTH} characters long`,
    )
  }

  return explicit
}

function getDatabaseEncryptionKey() {
  return new Uint8Array(
    crypto.createHash("sha256").update(getDatabaseEncryptionSecret()).digest(),
  )
}

function encryptDatabaseValue(value: string) {
  const ivBuffer = crypto.randomBytes(12)
  const iv = new Uint8Array(ivBuffer)
  const cipher = crypto.createCipheriv(
    ENCRYPTION_ALGORITHM,
    getDatabaseEncryptionKey(),
    iv,
  )
  let encrypted = cipher.update(value, "utf8", "base64")
  encrypted += cipher.final("base64")
  const authTag = cipher.getAuthTag().toString("base64")
  const ivBase64 = ivBuffer.toString("base64")
  return `${ENCRYPTION_VERSION_PREFIX}${ivBase64}.${authTag}.${encrypted}`
}

function decryptDatabaseValue(value: string) {
  if (!value.startsWith(ENCRYPTION_VERSION_PREFIX)) {
    throw new Error("Encrypted value is missing a supported prefix")
  }

  const [ivBase64, authTagBase64, encrypted, ...unexpected] = value
    .slice(ENCRYPTION_VERSION_PREFIX.length)
    .split(".")
  // AES-GCM legitimately produces an empty ciphertext for an empty plaintext;
  // the IV and authentication tag still authenticate that value. Artifact view
  // revisions use empty encrypted strings for optional CSS, so distinguish a
  // missing segment from a present-but-empty ciphertext segment.
  if (!ivBase64 || !authTagBase64 || encrypted === undefined || unexpected.length > 0) {
    throw new Error("Encrypted value is malformed")
  }

  const iv = new Uint8Array(Buffer.from(ivBase64, "base64"))
  const decipher = crypto.createDecipheriv(
    ENCRYPTION_ALGORITHM,
    getDatabaseEncryptionKey(),
    iv,
  )
  decipher.setAuthTag(new Uint8Array(Buffer.from(authTagBase64, "base64")))
  let decrypted = decipher.update(encrypted, "base64", "utf8")
  decrypted += decipher.final("utf8")
  return decrypted
}

type EncryptedColumnOptions<TData> = {
  dataType?: "text" | "mediumtext"
  serialize: (value: TData) => string
  deserialize: (value: string) => TData
}

export function encryptedColumn<TData>(
  columnName: string,
  options: EncryptedColumnOptions<TData>,
) {
  return customType<{ data: TData; driverData: string }>({
    dataType() {
      return options.dataType ?? "text"
    },
    toDriver(value) {
      return encryptDatabaseValue(options.serialize(value))
    },
    fromDriver(value) {
      return options.deserialize(decryptDatabaseValue(value))
    },
  })(columnName)
}

export const encryptedTextColumn = (columnName: string) =>
  encryptedColumn<string>(columnName, {
    serialize: (value) => value,
    deserialize: (value) => value,
  })

export const encryptedMediumTextColumn = (columnName: string) =>
  encryptedColumn<string>(columnName, {
    dataType: "mediumtext",
    serialize: (value) => value,
    deserialize: (value) => value,
  })

/**
 * Drizzle's `json()` returns whatever the driver produced: MySQL's native
 * JSON type arrives pre-parsed, but MariaDB aliases JSON to LONGTEXT and
 * mysql2 hands back the raw string. Parse strings on read so both engines
 * produce the declared shape.
 */
export const compatJsonColumn = <TData>(columnName: string) =>
  customType<{ data: TData; driverData: TData | string }>({
    dataType() {
      return "json"
    },
    toDriver(value) {
      return JSON.stringify(value)
    },
    fromDriver(value) {
      if (typeof value === "string") return JSON.parse(value)
      return value
    },
  })(columnName)

export const mediumBlobColumn = (columnName: string) =>
  customType<{ data: Uint8Array; driverData: Uint8Array }>({
    dataType() {
      return "mediumblob"
    },
    toDriver(value) {
      return value
    },
    fromDriver(value) {
      return Uint8Array.from(value)
    },
  })(columnName)

export const denTypeIdColumn = <TName extends DenTypeIdName>(
  name: TName,
  columnName: string,
) =>
  customType<{ data: DenTypeId<TName>; driverData: string }>({
    dataType() {
      return `varchar(${INTERNAL_ID_LENGTH})`
    },
    toDriver(value) {
      return normalizeDenTypeId(name, value)
    },
    fromDriver(value) {
      return normalizeDenTypeId(name, value)
    },
  })(columnName)

/**
 * A Den TypeID column for tables that stored plain UUIDs before adopting
 * TypeIDs. Stored legacy UUIDs read back as the equivalent TypeID, and any
 * UUID written or used as a query parameter is converted first, so new rows
 * always store TypeIDs. Optional `literals` pass through unchanged (for
 * example the `"unlimited"` placeholder in usage snapshots).
 *
 * Conversion only happens in Drizzle's typed column paths. SQL-level joins
 * compare stored values, so a row and its references must be converted
 * together; see `convertGatewayUsageLegacyIds`.
 */
export const legacyUuidDenTypeIdColumn = <
  TName extends DenTypeIdName,
  const TLiteral extends string = never,
>(
  name: TName,
  columnName: string,
  literals: readonly TLiteral[] = [],
) => {
  const allowed = new Set<string>(literals)
  const isLiteral = (value: string): value is TLiteral => allowed.has(value)
  const normalize = (value: string): DenTypeId<TName> | TLiteral =>
    isLiteral(value) ? value : normalizeDenTypeIdOrLegacyUuid(name, value)
  return customType<{ data: DenTypeId<TName> | TLiteral; driverData: string }>({
    dataType() {
      return `varchar(${INTERNAL_ID_LENGTH})`
    },
    toDriver: normalize,
    fromDriver: normalize,
  })(columnName)
}

export const timestamps = {
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
}
