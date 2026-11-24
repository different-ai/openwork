/**
 * Migration bodies that were changed after release, keyed by journal timestamp.
 * A database that applied the original body keeps that body's hash in its
 * receipt, so history checks accept these hashes as well as the current one.
 * Only list a change here when re-running the new body is unnecessary for
 * databases that applied the old one.
 */
export const supersededMigrationHashes: Readonly<Record<number, readonly string[]>> = {
  1791246307322: ["4a23d428e3b5c4e23fe147a2fd73cfedd3d73384c0f41e11327d203a05e802dc"],
  1791266169752: ["b544db5666c0be53acbb68851818cb4d99a5089239f2afba9dace972772fd49d"],
  1791533359673: ["7f5625e613f866f03f179edacf824df64716ffb6ee0472d3d18aaf706aae4ed9"],
  1791943155627: ["7ea8b3fb36cd293c31def5ca70e024493d6cf5358978f674284d09f151b9059f"],
}

export function receiptMatchesMigration(receiptHash: unknown, migration: { hash: string; folderMillis: number }) {
  if (receiptHash === migration.hash) return true
  return typeof receiptHash === "string" && (supersededMigrationHashes[migration.folderMillis]?.includes(receiptHash) ?? false)
}
