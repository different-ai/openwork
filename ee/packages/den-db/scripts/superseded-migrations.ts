/**
 * Migration bodies that were changed after release, keyed by journal timestamp.
 * A database that applied the original body keeps that body's hash in its
 * receipt, so history checks accept these hashes as well as the current one.
 * Only list a change here when re-running the new body is unnecessary for
 * databases that applied the old one.
 */
export const supersededMigrationHashes: Readonly<Record<number, readonly string[]>> = {
  // 0128_remove_legacy_analytics: shipped in v0.18.57 dropping the legacy
  // analytics tables; now a no-op so installs that skipped it keep their data.
  1791246307322: ["4a23d428e3b5c4e23fe147a2fd73cfedd3d73384c0f41e11327d203a05e802dc"],
}

export function receiptMatchesMigration(receiptHash: unknown, migration: { hash: string; folderMillis: number }) {
  if (receiptHash === migration.hash) return true
  return typeof receiptHash === "string" && (supersededMigrationHashes[migration.folderMillis]?.includes(receiptHash) ?? false)
}
