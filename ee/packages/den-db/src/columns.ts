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

// Binary values: the prefix bytes, a 12-byte IV, the 16-byte GCM tag, then the ciphertext.
const ENCRYPTED_BYTES_PREFIX = new Uint8Array(Buffer.from("enc:b1:", "utf8"))

export function encryptDatabaseBytes(value: Uint8Array): Uint8Array {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, getDatabaseEncryptionKey(), new Uint8Array(iv))
  const encrypted = [cipher.update(value), cipher.final()]
  // The tag exists only once final() has run.
  const parts = [ENCRYPTED_BYTES_PREFIX, iv, cipher.getAuthTag(), ...encrypted]
  return new Uint8Array(Buffer.concat(parts.map((part) => new Uint8Array(part))))
}

export function decryptDatabaseBytes(value: Uint8Array): Uint8Array {
  const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  const headerLength = ENCRYPTED_BYTES_PREFIX.length + 12 + 16
  if (buffer.length < headerLength || !buffer.subarray(0, ENCRYPTED_BYTES_PREFIX.length).equals(ENCRYPTED_BYTES_PREFIX)) {
    throw new Error("Encrypted bytes are missing a supported prefix")
  }
  const ivStart = ENCRYPTED_BYTES_PREFIX.length
  const decipher = crypto.createDecipheriv(
    ENCRYPTION_ALGORITHM,
    getDatabaseEncryptionKey(),
    new Uint8Array(buffer.subarray(ivStart, ivStart + 12)),
  )
  decipher.setAuthTag(new Uint8Array(buffer.subarray(ivStart + 12, headerLength)))
  const parts = [decipher.update(new Uint8Array(buffer.subarray(headerLength))), decipher.final()]
  return new Uint8Array(Buffer.concat(parts.map((part) => new Uint8Array(part))))
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

/** Binary data encrypted at rest; holds up to 16 MiB less 35 bytes of encryption header. */
export const encryptedMediumBlobColumn = (columnName: string) =>
  customType<{ data: Uint8Array; driverData: Uint8Array }>({
    dataType() {
      return "mediumblob"
    },
    toDriver(value) {
      return encryptDatabaseBytes(value)
    },
    fromDriver(value) {
      return decryptDatabaseBytes(Uint8Array.from(value))
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

export const timestamps = {
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
}
