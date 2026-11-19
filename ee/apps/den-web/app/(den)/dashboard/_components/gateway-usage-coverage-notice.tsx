import { ChevronDown } from "lucide-react";
import type { GatewayUsageResponse } from "@openwork/types/den/gateway-usage";

const docsUrl = "https://openworklabs.com/docs/ai-gateway/counting-usage#uncountable-items";
const categories: { outcome: keyof NonNullable<GatewayUsageResponse["usage"]["uncountableRequests"]>; label: string }[] = [
  { outcome: "upstream_error", label: "Provider errors" },
  { outcome: "upstream_unreachable", label: "Connection failures" },
  { outcome: "client_aborted", label: "Cancellations and interruptions" },
  { outcome: "rejected", label: "Rejected requests" },
  { outcome: "ok", label: "Completed without reported usage" },
];

export function GatewayUsageCoverageNotice({ usage }: { usage: GatewayUsageResponse["usage"] }) {
  if (usage.unreportedRequests === 0) return null;
  const counts = usage.uncountableRequests;
  return <div className="mt-5 text-xs leading-5 text-gray-500">
    <p>The data does not include uncountable queries, <a href={docsUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-gray-900">read more about it here</a>.</p>
    <details className="group mt-1">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
        Uncountable query details
      </summary>
      <div className="mt-2 max-w-sm pl-5">
        {counts ? <dl className="space-y-1">
          {categories.map(({ outcome, label }) => {
            const count = counts[outcome];
            return <div key={outcome} className="flex items-baseline justify-between gap-4">
              <dt>{label}</dt>
              <dd className="tabular-nums">{count === null ? "Unavailable" : count.toLocaleString()}</dd>
            </div>;
          })}
        </dl> : null}
        {!counts || Object.values(counts).some((count) => count === null)
          ? <p className="mt-2">Some older records do not retain a breakdown by outcome.{usage.unreportedRequests !== null ? ` There are ${usage.unreportedRequests.toLocaleString()} uncountable queries in this period.` : " Their total is also unavailable."}</p> : null}
        {usage.groupBy === "team" ? <p className="mt-2">Counts follow current team membership; a query may appear in more than one team.</p> : null}
      </div>
    </details>
  </div>;
}
