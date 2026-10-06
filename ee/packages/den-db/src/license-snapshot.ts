import { eq, ne } from "drizzle-orm"
import type { createDenDb } from "./client"
import { entitlementSnapshotSchema, type EntitlementSnapshot } from "./organization-modules-contract"
import { LicenseSnapshotTable } from "./schema/system"

/**
 * Persistence for the self-hosted instance entitlement snapshot (discovery
 * §7.2, plan W0-02). Unused until the license client lands (Phase 5); the
 * license client computes the fingerprint (hex SHA-256 of
 * `licenseKey + "\n" + normalizedBaseUrl`) and never stores the key itself.
 */

type Db = ReturnType<typeof createDenDb>["db"]
export type LicenseSnapshotExecutor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0]

export type ReadLicenseSnapshotResult =
  | { status: "absent" }
  | { status: "valid"; snapshot: EntitlementSnapshot }
  | { status: "invalid"; issues: string[] }

const fingerprintPattern = /^[0-9a-f]{64}$/

function assertFingerprint(fingerprint: string) {
  if (!fingerprintPattern.test(fingerprint)) throw new Error("License snapshot fingerprint must be a lowercase hex SHA-256 digest.")
}

export async function readLicenseSnapshot(executor: LicenseSnapshotExecutor, fingerprint: string): Promise<ReadLicenseSnapshotResult> {
  assertFingerprint(fingerprint)
  const rows = await executor
    .select({ snapshot: LicenseSnapshotTable.snapshot })
    .from(LicenseSnapshotTable)
    .where(eq(LicenseSnapshotTable.fingerprint, fingerprint))
    .limit(1)
  const row = rows[0]
  if (!row) return { status: "absent" }
  let value: unknown = row.snapshot
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return { status: "invalid", issues: ["(root): stored value is not valid JSON"] }
    }
  }
  const parsed = entitlementSnapshotSchema.safeParse(value)
  if (!parsed.success) {
    return { status: "invalid", issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`) }
  }
  return { status: "valid", snapshot: parsed.data }
}

/** Upserts this fingerprint and deletes every other row, so the table holds one snapshot. */
export async function writeLicenseSnapshot(executor: LicenseSnapshotExecutor, fingerprint: string, snapshot: EntitlementSnapshot): Promise<void> {
  assertFingerprint(fingerprint)
  const value = entitlementSnapshotSchema.parse(snapshot)
  await executor
    .insert(LicenseSnapshotTable)
    .values({ fingerprint, snapshot: value })
    .onDuplicateKeyUpdate({ set: { snapshot: value } })
  await executor.delete(LicenseSnapshotTable).where(ne(LicenseSnapshotTable.fingerprint, fingerprint))
}
