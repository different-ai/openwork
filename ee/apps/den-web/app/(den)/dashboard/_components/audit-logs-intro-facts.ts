import type { AuditLogsFacts } from "../_features/feature-intros/intros/audit-logs";
import type { AuditFilters } from "./audit-logs-data";

/**
 * Facts for Audit logs from the org's entitlement and the first page of
 * operations. Null until a page has loaded, and while filters are applied
 * (a filtered empty list says nothing about the organization).
 */
export function auditLogsIntroFacts(input: {
  included: boolean;
  filters: AuditFilters;
  operations: readonly unknown[] | undefined;
}): AuditLogsFacts | null {
  if (!input.operations) return null;
  if (Object.values(input.filters).some(Boolean)) return null;
  return { included: input.included, operations: input.operations.length };
}
