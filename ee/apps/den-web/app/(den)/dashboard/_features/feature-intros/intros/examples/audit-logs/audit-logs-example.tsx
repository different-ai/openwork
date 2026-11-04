"use client";

import { AuditOutcome, auditActionSentence } from "../../../../../_components/audit-logs-details";
import { ExampleAvatar, ExampleCaption, ExampleRow, ExampleRows } from "../example-parts";
import { useExampleStep } from "../use-example-step";
import { auditLogsExampleRows } from "./audit-logs-example-data";

/** Section example: recent changes as the Audit logs list words them, with who, what, result and when. */
export function AuditLogsExample() {
  const step = useExampleStep(auditLogsExampleRows.length);

  return (
    <div>
      <ExampleCaption>Recent changes in your organization</ExampleCaption>
      <ExampleRows>
        {auditLogsExampleRows.map((row, index) => (
          <ExampleRow key={`${row.actor}-${row.action}`} active={step === index}>
            <ExampleAvatar>{row.initials}</ExampleAvatar>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium leading-5 text-gray-900">{row.actor} {auditActionSentence(row.action)}</span>
              <span className="block truncate text-[12px] text-gray-500">{row.target}</span>
            </span>
            <span className="flex shrink-0 flex-col items-end text-[12px]">
              <AuditOutcome outcome={row.outcome} />
              <span className="tabular-nums text-gray-500">{row.when}</span>
            </span>
          </ExampleRow>
        ))}
      </ExampleRows>
    </div>
  );
}
