"use client";

import { ChevronRight } from "lucide-react";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton } from "../../_components/ui/button";
import type { DiscoveryCheck } from "./connector-discovery-stream";
import { SetupChecks, type SetupCheck } from "./setup-checks";

const PHASES: Array<{ id: DiscoveryCheck["id"]; title: string }> = [
  { id: "server", title: "Connecting to the server" },
  { id: "resource", title: "Looking up sign-in settings" },
  { id: "provider", title: "Checking the sign-in provider" },
];

/** Display only receipts from the server; an HTTP 200 is not proof of valid OAuth metadata. */
export function discoveryCheckDescription(check: DiscoveryCheck | undefined, discovering: boolean): string {
  if (!check) return discovering ? "Waiting" : "No result reported";
  if (check.status === "running") return "Checking";
  if (check.status === "passed") return check.code === "authentication_required" ? "Reached the server. Sign-in is required." : "Done";
  if (check.status === "skipped") return check.code === "not_required" ? "Not needed" : "Not checked";
  if (check.code === "issuer_mismatch") return "Sign-in information is inconsistent. Review the sign-in addresses below.";
  if (check.id === "server") return "Could not verify the server. Check the address or add the headers it needs.";
  if (check.id === "resource") return "Could not verify sign-in settings. Choose a route below or check again.";
  return "Could not verify the sign-in provider. Use your own OAuth app or check again.";
}

/** The reference's three live checks, inline with the connector rather than another setup page. */
export function ConnectorDiscoveryChecks({ checks, discovering, failed, onRetry }: {
  checks: DiscoveryCheck[];
  discovering: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const needsAttention = failed || checks.some((check) => check.status === "failed");
  const summary = discovering ? "Checking the server…" : needsAttention ? "Needs attention" : checks.length ? "Detection complete" : "Live details unavailable";
  const rows: SetupCheck[] = PHASES.map(({ id, title }) => {
    const check = checks.find((entry) => entry.id === id);
    return {
      id,
      title,
      status: check?.status === "passed" ? "done" : check?.status === "skipped" ? "skipped" : check?.status ?? "waiting",
      description: discoveryCheckDescription(check, discovering),
      ...(check?.httpStatus ? { action: <span aria-label={`HTTP status ${check.httpStatus}`}><DenBadge size="sm">{check.httpStatus}</DenBadge></span> } : {}),
    };
  });
  return (
    <details className="group/discovery" open={discovering || needsAttention} data-testid="connector-discovery-checks">
      <summary data-testid="connector-discovery-summary" aria-label="Server checks" className="flex cursor-pointer list-none items-center gap-2 text-[13px] font-medium text-gray-700 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open/discovery:rotate-90 motion-reduce:transition-none" aria-hidden />
        Server checks
        <span className="ml-auto text-[12px] font-normal text-gray-500" role="status" aria-live="polite">{summary}</span>
      </summary>
      <div className="mt-3 flex flex-col items-stretch gap-3">
        <SetupChecks checks={rows} />
        <div className="flex justify-end">
          <DenButton size="sm" variant="secondary" disabled={discovering} onClick={onRetry} data-testid="connector-discovery-retry">Check again</DenButton>
        </div>
      </div>
    </details>
  );
}
