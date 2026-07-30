import { createHash, randomUUID } from "node:crypto"
import { and, eq, gt, lt } from "@openwork-ee/den-db/drizzle"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { FileReferenceTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"

export const FILE_REFERENCE_MAX_BYTES = 10 * 1024 * 1024
export const FILE_REFERENCE_TTL_MS = 24 * 60 * 60 * 1000

export type FileReferenceScope = {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
}

export type StoredFileReference = {
  fileRef: string
  filename: string
  mimeType: string
  byteLength: number
  sha256: string
  bytes: Uint8Array
  expiresAt: Date
}

export type FileReferenceStorage = {
  put(input: FileReferenceScope & {
    filename: string
    mimeType: string
    bytes: Uint8Array
    now?: Date
  }): Promise<StoredFileReference>
  read(input: FileReferenceScope & { fileRef: string; now?: Date }): Promise<StoredFileReference | null>
  deleteExpired(now?: Date): Promise<number>
}

function fileReferenceId() {
  return `file_ref_${randomUUID().replaceAll("-", "")}`
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

export const databaseFileReferenceStorage: FileReferenceStorage = {
  async put(input) {
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > FILE_REFERENCE_MAX_BYTES) {
      throw new RangeError(`File references must contain between 1 and ${FILE_REFERENCE_MAX_BYTES} bytes.`)
    }
    const now = input.now ?? new Date()
    const expiresAt = new Date(now.getTime() + FILE_REFERENCE_TTL_MS)
    const fileRef = fileReferenceId()
    const sha256 = digest(input.bytes)
    await db.delete(FileReferenceTable).where(lt(FileReferenceTable.expiresAt, now))
    await db.insert(FileReferenceTable).values({
      id: fileRef,
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      filename: input.filename,
      mimeType: input.mimeType,
      byteLength: input.bytes.byteLength,
      sha256,
      bytes: input.bytes,
      expiresAt,
    })
    return {
      fileRef,
      filename: input.filename,
      mimeType: input.mimeType,
      byteLength: input.bytes.byteLength,
      sha256,
      bytes: input.bytes,
      expiresAt,
    }
  },

  async read(input) {
    const now = input.now ?? new Date()
    const [row] = await db
      .select()
      .from(FileReferenceTable)
      .where(and(
        eq(FileReferenceTable.id, input.fileRef),
        eq(FileReferenceTable.organizationId, input.organizationId),
        eq(FileReferenceTable.orgMembershipId, input.orgMembershipId),
        gt(FileReferenceTable.expiresAt, now),
      ))
      .limit(1)
    if (!row) return null
    return {
      fileRef: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      byteLength: row.byteLength,
      sha256: row.sha256,
      bytes: row.bytes,
      expiresAt: row.expiresAt,
    }
  },

  async deleteExpired(now = new Date()) {
    const result = await db.delete(FileReferenceTable).where(lt(FileReferenceTable.expiresAt, now))
    const affectedRows = (result as unknown as { affectedRows?: unknown }).affectedRows
    return typeof affectedRows === "number" ? affectedRows : 0
  },
}
