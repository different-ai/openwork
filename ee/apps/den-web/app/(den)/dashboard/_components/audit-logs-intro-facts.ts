import type { AuditLogsFacts } from "../_features/feature-intros/intros/audit-logs";
import type { AuditFilters } from "./audit-logs-data";

export function auditLogsIntroFacts(input: {
  included: boolean;
  filters: AuditFilters;
  operations: readonly unknown[] | undefined;
}): AuditLogsFacts | null {
  if (!input.operations) return null;
  if (Object.values(input.filters).some(Boolean)) return null;
  return { included: input.included, operations: input.operations.length };
}
