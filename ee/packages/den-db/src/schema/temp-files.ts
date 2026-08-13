import { bigint, index, mysqlEnum, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

const tempFileStorageTiers = ["volume", "s3"] as const
const tempFileStatuses = ["pending", "uploaded"] as const

// Temporary files hold short-lived workspace bytes so URL-accepting tools can
// fetch them. Bytes live in the configured storage backend, never in a column:
// the PlanetScale HTTP driver inlines binary parameters as hex text, which
// doubles a blob's size inside the SQL statement itself.
export const TempFileTable = mysqlTable(
  "temp_file",
  {
    id: denTypeIdColumn("tempFile", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    created_by_user_id: denTypeIdColumn("user", "created_by_user_id").notNull(),
    upload_token_hash: varchar("upload_token_hash", { length: 128 }).notNull(),
    download_token_hash: varchar("download_token_hash", { length: 128 }).notNull(),
    filename: varchar("filename", { length: 255 }).notNull(),
    content_type: varchar("content_type", { length: 255 }).notNull().default("application/octet-stream"),
    max_bytes: bigint("max_bytes", { mode: "number" }).notNull(),
    size_bytes: bigint("size_bytes", { mode: "number" }),
    storage_tier: mysqlEnum("storage_tier", tempFileStorageTiers).notNull(),
    storage_key: varchar("storage_key", { length: 512 }).notNull(),
    status: mysqlEnum("status", tempFileStatuses).notNull().default("pending"),
    // Base64url SHA-256, unpadded: 43 characters. The expected digest is what
    // the caller promised at mint time, and the content digest is what the
    // stored bytes actually hashed to.
    expected_sha256: varchar("expected_sha256", { length: 64 }),
    content_sha256: varchar("content_sha256", { length: 64 }),
    uploaded_at: timestamp("uploaded_at", { fsp: 3 }),
    expires_at: timestamp("expires_at", { fsp: 3 }).notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("temp_file_upload_token_hash").on(table.upload_token_hash),
    uniqueIndex("temp_file_download_token_hash").on(table.download_token_hash),
    index("temp_file_organization_id").on(table.organization_id),
    index("temp_file_expires_at").on(table.expires_at),
  ],
)

export type TempFileStorageTier = (typeof tempFileStorageTiers)[number]
export type TempFileStatus = (typeof tempFileStatuses)[number]
