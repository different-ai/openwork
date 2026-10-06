/**
 * The `organization.modules` document and entitlement snapshot schemas, from
 * the public contracts package (W0-01). Re-exported here so den-db callers
 * keep one import path.
 */
export {
  entitlementSnapshotSchema,
  organizationModulesSchema,
  type EntitlementSnapshot,
  type OrganizationModules,
} from "@openwork/license-contracts/org-modules"
