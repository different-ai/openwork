import type { AuditOperationSummary } from "@openwork/types/den/audit";

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
