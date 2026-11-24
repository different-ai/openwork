import { useEffect, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ActivationClientEvent, ActivationState } from "@openwork/types/den/activation";
import { createDenClient, denOriginComparisonKey } from "@/app/lib/den";
import { readGatewayUsageScope, subscribeGatewayUsageScope } from "@/app/lib/gateway-usage-scope";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { AUTO_PROVIDER_ID } from "@/react-app/domains/models/model-catalog";
import { isCloudManagedProviderKey } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { providerCredentialScope, useProviderCredentialHealth } from "@/react-app/domains/connections/provider-auth/credential-health";
import { useDenAuth } from "../den-auth-provider";
import { useOrgFeature } from "../use-org-feature";
import { activationHiddenStorageKey, createActivationReporter, draftUsesSkill, hasDeviceConnection, hasVerifiedDeviceProvider } from "./activation-model";
import { createActivationCache } from "./activation-cache";

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
    staleTime: (current) => (current.state.data === null ? 300_000 : 30_000),
    refetchOnWindowFocus: "always",
    retry: false,
  });
  const state = authorized ? query.data ?? null : null;
  const prefixKey = JSON.stringify(activationQueryPrefix(scope));
  useEffect(() => {
    if (!state || !pendingFirstAnswer || pendingFirstAnswer.key !== prefixKey) return;
    const { durationMs } = pendingFirstAnswer;
    pendingFirstAnswer = null;
    void reportActivationEvent("first_response", durationMs);
  }, [state, prefixKey]);
  const localSetup = useOrgFeature("activationLocalSetup");
  useEffect(() => {
    if (!authorized || !localSetup) return;
    localSetupKey = prefixKey;
    reportDeviceConnection();
    return () => { if (localSetupKey === prefixKey) localSetupKey = null; };
  }, [authorized, localSetup, prefixKey]);
  const deviceProviderWorks = useProviderCredentialHealth((health) => hasVerifiedDeviceProvider(health, managedProvider));
  useEffect(() => {
    if (state && localSetup && deviceProviderWorks) void reportActivationEvent("own_provider");
  }, [state, localSetup, deviceProviderWorks]);
  const denOrigin = denOriginComparisonKey(scope.baseUrl);
  const hiddenKey = authorized && denOrigin && organizationId && principalId
    ? activationHiddenStorageKey({ origin: denOrigin, organizationId, principalId })
    : null;
  const hidden = useSyncExternalStore(subscribeHidden, () => readHidden(hiddenKey), () => false);
  const hide = () => {
    if (!hiddenKey) return;
    writeHidden(hiddenKey);
    void reportActivationEvent("dismiss");
  };
  return { state, hidden, hide, refetch: query.refetch };
}

const hiddenListeners = new Set<() => void>();

function subscribeHidden(listener: () => void) {
  hiddenListeners.add(listener);
  return () => { hiddenListeners.delete(listener); };
}

function readHidden(key: string | null): boolean {
  if (!key) return false;
  if (hiddenOverrides.has(key)) return true;
  try { return window.localStorage.getItem(key) === "1"; } catch { return false; }
}

function writeHidden(key: string) {
  try { window.localStorage.setItem(key, "1"); } catch {}
  hiddenOverrides.add(key);
  for (const listener of hiddenListeners) listener();
}

const hiddenOverrides = new Set<string>();

type ReporterScope = DenScope & { key: string; source: DenScope; queryKey: readonly unknown[] };

const report = createActivationReporter<ReporterScope>({
  readState: (scope) => activationCache.read(scope.source),
  send: (scope, step, durationMs) => scope.organizationId
    ? clientFor(scope).recordActivationEvent(scope.organizationId, { step, ...(durationMs !== undefined ? { durationMs: Math.min(Math.max(0, Math.round(durationMs)), 24 * 60 * 60 * 1000) } : {}) })
    : Promise.resolve(null),
  onState: (scope, state) => { activationCache.write(scope.source, state, scope.queryKey); },
});

export function reportActivationEvent(step: ActivationClientEvent, durationMs?: number): Promise<boolean> {
  const scope = readGatewayUsageScope();
  if (!scope.token || !scope.organizationId) return Promise.resolve(false);
  const queryKey = activationCache.key(scope);
  if (!queryKey) return Promise.resolve(false);
  return report({ ...scope, source: scope, queryKey, key: JSON.stringify(queryKey) }, step, durationMs);
}

function managedProvider(providerId: string): boolean {
  return isCloudManagedProviderKey(providerId) || providerId === AUTO_PROVIDER_ID;
}

let localSetupKey: string | null = null;

let deviceConnectionSeen = false;

export function noteActivationConnectionStatuses(engineBaseUrl: string, statuses: Readonly<Record<string, { status: string }>>) {
  deviceConnectionSeen = providerCredentialScope(engineBaseUrl) === "device" && hasDeviceConnection(statuses);
  reportDeviceConnection();
}

function reportDeviceConnection() {
  if (!deviceConnectionSeen || !localSetupKey) return;
  const scope = readGatewayUsageScope();
  if (!scope.token || !scope.organizationId || localSetupKey !== JSON.stringify(activationQueryPrefix(scope))) return;
  void reportActivationEvent("connector");
}

const skillRuns = new Set<string>();
let pendingFirstAnswer: { key: string; durationMs: number } | null = null;

export function noteActivationRunStarted(sessionId: string, parts: readonly { type: string }[] | undefined) {
  if (draftUsesSkill(parts)) skillRuns.add(sessionId);
}

export function noteActivationRunCompleted(sessionId: string, durationMs: number) {
  const scope = readGatewayUsageScope();
  if (scope.token && scope.organizationId) pendingFirstAnswer ??= { key: JSON.stringify(activationQueryPrefix(scope)), durationMs };
  void reportActivationEvent("first_response", durationMs);
  if (skillRuns.delete(sessionId)) void reportActivationEvent("use_skill");
}
