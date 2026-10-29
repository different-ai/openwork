/**
 * Stored shapes of the retired organization grants (`organization_benefit_setting`,
 * `organization_grant`, `organization_grant_usage`). The tables are kept so no
 * data is dropped; nothing reads or writes them any more.
 */
export const ORGANIZATION_BENEFITS = ["freeAuto", "openworkWeb"] as const;
export const ORGANIZATION_GRANT_TYPES = ["access", "usage", "unlimited"] as const;
export type OrganizationBenefit = typeof ORGANIZATION_BENEFITS[number];
