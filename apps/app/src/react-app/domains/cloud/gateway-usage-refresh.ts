import { gatewayUsageStatusSchema, type GatewayUsageStatus } from "@openwork/types/den/gateway-usage-limits";
import { readGatewayUsageScope, subscribeGatewayUsageScope } from "@/app/lib/gateway-usage-scope";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { gatewayUsageQueryPrefix } from "./gateway-usage-state";

export async function refreshGatewayUsageAfterCloudSync(scope: ReturnType<typeof readGatewayUsageScope>) {
  if (scope !== readGatewayUsageScope() || !scope.token || !scope.organizationId) return;
  try {
    await getReactQueryClient().invalidateQueries({
      queryKey: [...gatewayUsageQueryPrefix, scope.generation, scope.organizationId],
      type: "active",
    }, { cancelRefetch: false });
  } catch { }
}

export const gatewayUsageSettlementDelays = [2000, 5000, 10_000, 20_000];

export function gatewayUsageNeedsSettlement(coverage: GatewayUsageStatus["coverage"]): boolean {
  if (coverage.settlementReady !== undefined) return !coverage.settlementReady;
  return !coverage.complete || coverage.unpricedRequests > 0
    || (coverage.incompleteRequests ?? 0) > 0 || (coverage.quarantinedRequests ?? 0) > 0;
}

export function createGatewayUsageSettlementRefresh(input: {
  refresh: () => Promise<unknown>;
  hasUnresolved: () => boolean;
  isCurrent: () => boolean;
  schedule: (callback: () => void, delay: number) => () => void;
}) {
  const seen = new Set<string>();
  let running = false;
  let disposed = false;
  let restartRequested = false;
  let cancelTimer: (() => void) | undefined;
  const current = () => !disposed && input.isCurrent();
  const step = async (attempt: number) => {
    if (!current()) { running = false; return; }
    try { await input.refresh(); } catch { }
    if (!current()) { running = false; return; }
    const restart = restartRequested;
    const nextAttempt = restart ? 0 : attempt;
    restartRequested = false;
    if (nextAttempt >= gatewayUsageSettlementDelays.length || (!restart && !input.hasUnresolved())) {
      running = false;
      return;
    }
    cancelTimer = input.schedule(() => { cancelTimer = undefined; void step(nextAttempt + 1); }, gatewayUsageSettlementDelays[nextAttempt]);
  };
  return {
    complete(key: string) {
      if (!current() || seen.has(key)) return;
      seen.add(key);
      if (seen.size > 128) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      if (running && !cancelTimer) { restartRequested = true; return; }
      cancelTimer?.();
      cancelTimer = undefined;
      running = true;
      void step(0);
    },
    dispose() {
      disposed = true;
      cancelTimer?.();
      cancelTimer = undefined;
      seen.clear();
    },
  };
}

let active: {
  scope: ReturnType<typeof readGatewayUsageScope>;
  runner: ReturnType<typeof createGatewayUsageSettlementRefresh>;
  unsubscribe: () => void;
} | undefined;

export function disposeGatewayUsageRefresh() {
  active?.runner.dispose();
  active?.unsubscribe();
  active = undefined;
}

export function refreshGatewayUsageAfterCompletion(scopeGeneration: number, completionKey: string) {
  const scope = readGatewayUsageScope();
  if (scope.generation !== scopeGeneration || !scope.token || !scope.organizationId) return;
  if (active?.scope !== scope) {
    disposeGatewayUsageRefresh();
    const client = getReactQueryClient();
    const runner = createGatewayUsageSettlementRefresh({
      refresh: () => client.invalidateQueries({ queryKey: gatewayUsageQueryPrefix }, { cancelRefetch: false }),
      hasUnresolved: () => client.getQueryCache().findAll({ queryKey: gatewayUsageQueryPrefix, type: "active" }).some((query) => {
        const result = gatewayUsageStatusSchema.safeParse(query.state.data);
        return query.state.status === "error" || !result.success || gatewayUsageNeedsSettlement(result.data.coverage);
      }),
      isCurrent: () => scope === readGatewayUsageScope(),
      schedule: (callback, delay) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    });
    const unsubscribe = typeof window === "undefined" ? () => {} : subscribeGatewayUsageScope(() => {
      if (scope !== readGatewayUsageScope()) disposeGatewayUsageRefresh();
    });
    active = { scope, runner, unsubscribe };
  }
  active.runner.complete(completionKey);
}
