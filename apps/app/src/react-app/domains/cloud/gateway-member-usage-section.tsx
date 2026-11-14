import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import {
  formatGatewaySpend,
  gatewayMemberSeriesTotals,
  gatewayMemberUsageMetrics,
  gatewayModelCostComparison,
  type GatewayListedPrice,
} from "@openwork/types/den/gateway-member-usage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { createDenClient, DenApiError } from "@/app/lib/den";
import { denDashboardUrl } from "@/app/lib/den-dashboard-links";
import { readGatewayUsageScope as readScope, subscribeGatewayUsageScope } from "@/app/lib/gateway-usage-scope";
import { usePlatform } from "@/react-app/kernel/platform";
import { useDenAuth } from "./den-auth-provider";
import { gatewayUsageQueryPrefix } from "./gateway-usage-state";

/** One titled group of rows in the Usage settings, as the limits above it. */
export function UsageSettingsSection({ title, detail, children, testId }: { title: string; detail?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section aria-label={title} data-testid={testId} className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[13px] font-semibold text-foreground">{title}</h2>
        {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
      </div>
      <div className="flex flex-col divide-y divide-border rounded-xl border border-border bg-background">{children}</div>
    </section>
  );
}

/**
 * The member's own past 30 days and the models they can use with listed prices,
 * from `GET /v1/gateway/usage/me`. Same scope and cleanup as the limits query.
 * Null when Den predates the route (404), so an older Den shows only the limits.
 */
function useGatewayMemberUsage() {
  const auth = useDenAuth();
  const scope = useSyncExternalStore(subscribeGatewayUsageScope, readScope, readScope);
  const authorized = Boolean(auth.isSignedIn && scope.token && scope.organizationId && auth.verifiedIdentity?.organizationId === scope.organizationId);
  const query = useQuery({
    queryKey: [...gatewayUsageQueryPrefix, "member-usage", scope.generation, scope.organizationId, auth.verifiedIdentity?.principalId ?? null],
    enabled: authorized,
    queryFn: async ({ signal }) => {
      const organizationId = scope.organizationId;
      if (!organizationId) throw new Error("Sign in and select an organization to view your usage.");
      const client = createDenClient({ baseUrl: scope.baseUrl, apiBaseUrl: scope.apiBaseUrl, token: scope.token });
      const data = await client.getGatewayMemberUsage(organizationId).catch((error: unknown) => {
        if (error instanceof DenApiError && error.status === 404) return null;
        throw error;
      });
      signal.throwIfAborted();
      if (readScope() !== scope) throw new Error("The signed-in organization changed. Reopen usage.");
      return data;
    },
    gcTime: 0,
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: "always",
  });
  return { query, authorized, baseUrl: scope.baseUrl };
}

function Row({ children, testId }: { children: ReactNode; testId?: string }) {
  return <div data-testid={testId} className="flex items-center gap-3 px-3.5 py-2.5 text-[13px]">{children}</div>;
}

function Figure({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-3.5 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-[15px] font-medium tabular-nums text-foreground">{value}</span>
      {detail ? <span className="truncate text-xs text-muted-foreground">{detail}</span> : null}
    </div>
  );
}

function priceLine(price: GatewayListedPrice): string {
  const usd = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  return `${usd(price.input)} in, ${usd(price.output)} out per 1M tokens`;
}

/** Past 30 days and model prices under the limits. */
export function GatewayMemberUsageSections() {
  const platform = usePlatform();
  const { query, authorized, baseUrl } = useGatewayMemberUsage();
  if (!authorized || query.data === null) return null;
  const openWeb = <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => platform.openLink(denDashboardUrl(baseUrl, "myUsage"))}>Open My Usage on the web</Button>;
  if (query.isPending) {
    return (
      <div role="status" aria-label="Loading your usage" className="flex flex-col gap-3" data-testid="gateway-member-usage-loading">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-20 w-full rounded-xl" />
      </div>
    );
  }
  if (!query.data) {
    return (
      <UsageSettingsSection title="Past 30 days" testId="gateway-member-usage">
        <div role="alert" className="flex items-center justify-between gap-3 px-3.5 py-3 text-[13px]">
          <span className="text-muted-foreground">Couldn’t load your usage.</span>
          <Button size="sm" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>Try again</Button>
        </div>
      </UsageSettingsSection>
    );
  }
  const { usage } = query.data;
  const metrics = gatewayMemberUsageMetrics(usage);
  const totals = gatewayMemberSeriesTotals(usage);
  const comparison = gatewayModelCostComparison(query.data);
  const measured = comparison.mix.measuredRequests;
  return (
    <>
      <UsageSettingsSection title="Past 30 days" detail={`UTC, ${usage.from} to ${usage.to}`} testId="gateway-member-usage">
        <div className="grid grid-cols-2 divide-x divide-border sm:grid-cols-4" data-testid="gateway-member-usage-metrics">
          <Figure label="Spend" value={metrics.spendMicroUsd === null ? "Unknown" : formatGatewaySpend(metrics.spendMicroUsd)}
            detail={metrics.unpricedRequests ? `${metrics.unpricedRequests.toLocaleString()} without a price yet` : "Approximate"} />
          <Figure label="Requests" value={metrics.requests === null ? "—" : metrics.requests.toLocaleString()} />
          <Figure label="Tokens" value={metrics.tokens.toLocaleString()} />
          <Figure label="Top model" value={metrics.topModel?.label ?? "None yet"} />
        </div>
        {totals.map((row) => (
          <Row key={row.id} testId="gateway-member-usage-model">
            <span className="min-w-0 flex-1 truncate text-foreground">{row.label}</span>
            <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">{row.tokens.toLocaleString()} tokens</span>
            <span className="w-20 text-right tabular-nums text-foreground">{row.unpriced && !row.costMicroUsd ? "Unknown" : formatGatewaySpend(row.costMicroUsd)}</span>
          </Row>
        ))}
        {!totals.length ? <Row><span className="text-muted-foreground">No AI Gateway requests in the past 30 days.</span></Row> : null}
      </UsageSettingsSection>
      <UsageSettingsSection title="Models you can use" testId="gateway-member-usage-catalog"
        detail={measured ? `What your past 30 days would have cost on each, at listed prices` : "Listed prices for the models shared with you"}>
        {comparison.rows.map((row) => (
          <Row key={`${row.model.providerName}:${row.model.seriesId}`} testId="gateway-member-usage-catalog-row">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-2">
                <span className="truncate text-foreground">{row.model.name}</span>
                {row.inUse ? <Badge variant="secondary">What you use now</Badge> : null}
              </span>
              <span className="truncate text-xs text-muted-foreground">{row.model.providerName}{row.model.price ? `: ${priceLine(row.model.price)}` : ""}</span>
            </span>
            <span className="shrink-0 text-right tabular-nums">
              {row.estimateMicroUsd === null ? <span className="text-xs text-muted-foreground">No listed price</span>
                : measured ? <span className="text-foreground">{formatGatewaySpend(row.estimateMicroUsd)}</span> : null}
            </span>
          </Row>
        ))}
        {!comparison.rows.length ? <Row><span className="text-muted-foreground">No AI Gateway models are shared with you yet.</span></Row> : null}
      </UsageSettingsSection>
      <div className="-mt-4 flex justify-start">{openWeb}</div>
    </>
  );
}
