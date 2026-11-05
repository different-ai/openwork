import type { AuditOperationSummary } from "@openwork/types/den/audit";

/**
 * Sample data only: no API calls (DESIGN.md I7). `action` is a real stored
 * action, so the row reads exactly as the Audit logs list words it
 * (`auditActionSentence`); `target` is the resource label under it.
 */
export const auditLogsExampleRows: ReadonlyArray<{
  actor: string;
  initials: string;
  action: string;
  target: string;
  outcome: AuditOperationSummary["outcome"];
  when: string;
}> = [
  { actor: "Priya Shah", initials: "PS", action: "team.create.requested", target: "Engineering", outcome: "succeeded", when: "10:42 AM" },
  { actor: "Ada Lovelace", initials: "AL", action: "api_key.created", target: "CI deploy key", outcome: "succeeded", when: "9:15 AM" },
  { actor: "Ada Lovelace", initials: "AL", action: "member.removed", target: "jo@acme.com", outcome: "succeeded", when: "Yesterday" },
  { actor: "Sam Lee", initials: "SL", action: "team.delete.requested", target: "Design", outcome: "failed", when: "Yesterday" },
];
