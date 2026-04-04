import * as crypto from "node:crypto"
import { customType, timestamp, varchar } from "drizzle-orm/mysql-core"
import {
  type DenTypeId,
  type DenTypeIdName,
  normalizeDenTypeId,
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

  const [ivBase64, authTagBase64, encrypted] = value
    .slice(ENCRYPTION_VERSION_PREFIX.length)
    .split(".")
  if (!ivBase64 || !authTagBase64 || !encrypted) {
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
  serialize: (value: TData) => string
  deserialize: (value: string) => TData
}

export function encryptedColumn<TData>(
  columnName: string,
  options: EncryptedColumnOptions<TData>,
) {
  return customType<{ data: TData; driverData: string }>({
    dataType() {
      return "text"
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

export const timestamps = {
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
}
