import { useEffect, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ActivationClientEvent, ActivationState } from "@openwork/types/den/activation";
import { createDenClient, denOriginComparisonKey } from "@/app/lib/den";
import { readGatewayUsageScope, subscribeGatewayUsageScope } from "@/app/lib/gateway-usage-scope";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { useDenAuth } from "../den-auth-provider";
import { createActivationReporter, draftUsesSkill } from "./activation-model";
import { createActivationCache } from "./activation-cache";

/**
 * The signed-in person's Get set up checklist from Den (`GET /v1/me/activation`). Den answers 404 while the
 * checklist is unavailable; the client then has no checklist and reports nothing.
 */

type DenScope = ReturnType<typeof readGatewayUsageScope>;

const activationCache = createActivationCache<DenScope>(getReactQueryClient);

function activationQueryPrefix(scope: DenScope) {
  return ["den-activation", denOriginComparisonKey(scope.baseUrl), scope.organizationId ?? null, scope.generation] as const;
}

function clientFor(scope: DenScope) {
  return createDenClient({ baseUrl: scope.baseUrl, apiBaseUrl: scope.apiBaseUrl, token: scope.token });
}

export function useActivation() {
  const auth = useDenAuth();
  const scope = useSyncExternalStore(subscribeGatewayUsageScope, readGatewayUsageScope, readGatewayUsageScope);
  const organizationId = scope.organizationId;
  const authorized = Boolean(auth.isSignedIn && scope.token && organizationId && auth.verifiedIdentity?.organizationId === organizationId);
  const principalId = auth.verifiedIdentity?.principalId ?? null;
  useEffect(() => {
    if (!authorized || !principalId) return;
    return activationCache.bind(scope, [...activationQueryPrefix(scope), principalId]);
  }, [authorized, principalId, scope]);
  const query = useQuery({
    queryKey: [...activationQueryPrefix(scope), principalId],
    enabled: authorized,
    queryFn: async (): Promise<ActivationState | null> => (organizationId ? clientFor(scope).getActivation(organizationId) : null),
    // Off (null) rarely changes: check again on focus or after a few minutes, not on every render.
    staleTime: (current) => (current.state.data === null ? 300_000 : 30_000),
    refetchOnWindowFocus: "always",
    retry: false,
  });
  const state = authorized ? query.data ?? null : null;
  const prefixKey = JSON.stringify(activationQueryPrefix(scope));
  // An answer that finished before Den's checklist was known is reported once it is.
  useEffect(() => {
    if (!state || !pendingFirstAnswer || pendingFirstAnswer.key !== prefixKey) return;
    const { durationMs } = pendingFirstAnswer;
    pendingFirstAnswer = null;
    void reportActivationEvent("first_response", durationMs);
  }, [state, prefixKey]);
  return { state, refetch: query.refetch };
}

type ReporterScope = DenScope & { key: string; source: DenScope; queryKey: readonly unknown[] };

const report = createActivationReporter<ReporterScope>({
  readState: (scope) => activationCache.read(scope.source),
  send: (scope, step, durationMs) => scope.organizationId
    ? clientFor(scope).recordActivationEvent(scope.organizationId, { step, ...(durationMs !== undefined ? { durationMs: Math.min(Math.max(0, Math.round(durationMs)), 24 * 60 * 60 * 1000) } : {}) })
    : Promise.resolve(null),
  onState: (scope, state) => { activationCache.write(scope.source, state, scope.queryKey); },
});

/** Reports a step only this app can observe, while Den shows the checklist; never throws. */
export function reportActivationEvent(step: ActivationClientEvent, durationMs?: number): Promise<boolean> {
  const scope = readGatewayUsageScope();
  if (!scope.token || !scope.organizationId) return Promise.resolve(false);
  const queryKey = activationCache.key(scope);
  if (!queryKey) return Promise.resolve(false);
  return report({ ...scope, source: scope, queryKey, key: JSON.stringify(queryKey) }, step, durationMs);
}

const skillRuns = new Set<string>();
let pendingFirstAnswer: { key: string; durationMs: number } | null = null;

/** A message was sent: remember whether it runs a skill, to report once its answer completes. */
export function noteActivationRunStarted(sessionId: string, parts: readonly { type: string }[] | undefined) {
  if (draftUsesSkill(parts)) skillRuns.add(sessionId);
}

/** An answer completed: the first answer (with how long it took) and, if the message ran a skill, using a skill. */
export function noteActivationRunCompleted(sessionId: string, durationMs: number) {
  const scope = readGatewayUsageScope();
  if (scope.token && scope.organizationId) pendingFirstAnswer ??= { key: JSON.stringify(activationQueryPrefix(scope)), durationMs };
  void reportActivationEvent("first_response", durationMs);
  if (skillRuns.delete(sessionId)) void reportActivationEvent("use_skill");
}
