import { createHash } from "node:crypto"
import { eq } from "@openwork-ee/den-db/drizzle"
import { readLicenseSnapshot, writeLicenseSnapshot } from "@openwork-ee/den-db/license-snapshot"
import {
  organizationModuleStateColumns,
  updateOrganizationModules,
  type EntitlementSnapshot,
  type OrganizationModules,
  type OrganizationModulesExecutor,
} from "@openwork-ee/den-db/organization-modules"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { OrgModuleRow } from "../org-row"

/** The den-db handle den-api and the gateway already construct. The package never opens its own connection. */
export type DenModulesDatabase = OrganizationModulesExecutor

export type OrgEntitlementPersistResult =
  | { readonly status: "written"; readonly modules: OrganizationModules }
  | { readonly status: "not_found" | "conflict_exhausted" }

/** Cloud: `organization.modules.entitlement`, written with the W0-02 helper (kind `entitlement`). */
export interface OrgEntitlementStore {
  persist(organizationId: string, next: EntitlementSnapshot): Promise<OrgEntitlementPersistResult>
}

/** Self-hosted: the single `license_snapshot` row. */
export interface InstanceSnapshotStore {
  load(fingerprint: string): Promise<EntitlementSnapshot | null>
  save(fingerprint: string, snapshot: EntitlementSnapshot): Promise<void>
}

/** den-api: Redis `SET key value PX ttl NX`. Absent → per-replica singleflight only. */
export interface LeaseStore {
  acquire(key: string, ttlMs: number): Promise<boolean>
}

/** Rows for jobs and helpers that only have an org id. */
export interface OrgRowLoader {
  load(organizationId: string): Promise<OrgModuleRow | null>
}

export function createDenDbOrgEntitlementStore(db: DenModulesDatabase): OrgEntitlementStore {
  return {
    async persist(organizationId, next) {
      const result = await updateOrganizationModules(db, {
        organizationId,
        kind: "entitlement",
        actorMemberId: null,
        mutate: (doc) => ({ ...doc, entitlement: next }),
      })
      if (result.ok) return { status: "written", modules: result.doc }
      return { status: result.reason === "not_found" ? "not_found" : "conflict_exhausted" }
    },
  }
}

export function createDenDbInstanceSnapshotStore(db: DenModulesDatabase): InstanceSnapshotStore {
  return {
    async load(fingerprint) {
      const result = await readLicenseSnapshot(db, fingerprint)
      return result.status === "valid" ? result.snapshot : null
    },
    async save(fingerprint, snapshot) {
      await writeLicenseSnapshot(db, fingerprint, snapshot)
    },
  }
}

export function createDenDbOrgRowLoader(db: DenModulesDatabase): OrgRowLoader {
  return {
    async load(organizationId) {
      const rows = await db
        .select(organizationModuleStateColumns)
        .from(OrganizationTable)
        .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId)))
        .limit(1)
      return rows[0] ?? null
    },
  }
}

/** Hex SHA-256 of `licenseKey + "\n" + normalizedBaseUrl`; the key itself is never stored. */
export function licenseKeyFingerprint(licenseKey: string, baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "")
  return createHash("sha256").update(`${licenseKey}\n${normalizedBaseUrl}`).digest("hex")
}
