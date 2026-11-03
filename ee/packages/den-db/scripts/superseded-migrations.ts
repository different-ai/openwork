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
  // 0129_organization_features: retry-safe table creation and portable JSON
  // parsing; existing completed backfills do not need to run again.
  1791266169752: ["b544db5666c0be53acbb68851818cb4d99a5089239f2afba9dace972772fd49d"],
  // 0138_deprecate_super_admin: preserve active super-admins in a team before
  // rewriting their roles. Already-deprecated databases must NOT run it again:
  // the original roles are gone and cannot be reconstructed safely.
  1791533359673: ["7f5625e613f866f03f179edacf824df64716ffb6ee0472d3d18aaf706aae4ed9"],
  // 0145_org_default_model: originally two statements (CREATE TABLE, then
  // CREATE INDEX). PlanetScale applies DDL outside the transaction, so a failed
  // index left the table behind and every retry hit "table already exists".
  // Now one idempotent statement; same resulting schema.
  1791943155627: ["7ea8b3fb36cd293c31def5ca70e024493d6cf5358978f674284d09f151b9059f"],
}

export function receiptMatchesMigration(receiptHash: unknown, migration: { hash: string; folderMillis: number }) {
  if (receiptHash === migration.hash) return true
  return typeof receiptHash === "string" && (supersededMigrationHashes[migration.folderMillis]?.includes(receiptHash) ?? false)
}
