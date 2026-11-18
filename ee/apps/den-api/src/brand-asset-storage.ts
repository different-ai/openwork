import { createHash } from "node:crypto"
import { OrganizationBrandAssetTable } from "@openwork-ee/den-db/schema"
import { eq } from "@openwork-ee/den-db/drizzle"
import type { BrandAssetStorage, BrandAssetStorageKey } from "./brand-assets.js"
import { db } from "./db.js"

function storageId(key: BrandAssetStorageKey) {
  return createHash("sha256")
    .update([key.organizationId, key.kind, key.version, key.extension].join("\0"))
    .digest("hex")
}

export const databaseBrandAssetStorage: BrandAssetStorage = {
  async put(key, bytes) {
    const value = new Uint8Array(bytes)
    await db
      .insert(OrganizationBrandAssetTable)
      .values({
        id: storageId(key),
        organizationId: key.organizationId,
        kind: key.kind,
        version: key.version,
        extension: key.extension,
        bytes: value,
      })
      .onDuplicateKeyUpdate({ set: { bytes: value } })
  },
  async read(key) {
    const lookup = (database: typeof db.$primary) => database
      .select({ bytes: OrganizationBrandAssetTable.bytes })
      .from(OrganizationBrandAssetTable)
      .where(eq(OrganizationBrandAssetTable.id, storageId(key)))
      .limit(1)
    // A just-uploaded asset is fetched right away; a replica that has not caught up falls back to the primary.
    const replica = await lookup(db)
    const [asset] = replica[0] ? replica : await lookup(db.$primary)
    return asset ? Uint8Array.from(asset.bytes).buffer : null
  },
}
