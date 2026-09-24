import { createContext, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import type { ModelOption, ModelRef } from "@/app/types";
import { denSessionUpdatedEvent, denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { toast } from "@/components/ui/sonner";
import { gatewayConnectProviderKey, gatewaySignInBrand, pendingGatewayModelOptions, type GatewayConnectProvider } from "./cloud-provider-config";
import { beginPendingGatewayModelSelection } from "./pending-gateway-model-selection";
import { markDisabledModelOptions } from "./assigned-model-options";

const noDisabledProviders: readonly string[] = [];

/** Signs the member in for one credential set; resolves true once its models are usable. */
export type GatewayModelLogin = (provider: GatewayConnectProvider, signal: AbortSignal, model?: ModelRef) => Promise<boolean>;

/** Where a sign-in stands, shown in place on the provider group that started it. */
export type GatewaySignInState =
  | { kind: "waiting"; providerKey: string; modelId: string | null }
  | { kind: "failed"; providerKey: string; message: string };

type Attempt = {
  providerKey: string;
  controller: AbortController;
  releaseDefaultRepair: () => void;
};

type GatewayModelAccess = {
  options: ModelOption[];
  disabledProviders: readonly string[];
  signIn: GatewaySignInState | null;
  /** Pick a model; one that needs the member's sign-in starts it and is picked once it succeeds. */
  select: (option: ModelOption, commit: () => void, isCurrent: () => boolean) => () => void;
  /** Sign in for a whole provider group without changing the current model. */
  signInProvider: (provider: GatewayConnectProvider) => void;
  /** The provider this model waits on for the member's sign-in, or null when it works now. */
  providerFor: (model: ModelRef) => GatewayConnectProvider | null;
  cancel: () => void;
};

const findWaitingProvider = (providers: readonly GatewayConnectProvider[], model: ModelRef) =>
  providers.find((entry) => entry.providerId === model.providerID
    && entry.models?.some((candidate) => candidate.id === model.modelID && candidate.credentialSetId === entry.credentialSetId)) ?? null;

export type GatewayModelSelectionHandle = Pick<GatewayModelAccess, "select">;

export const GATEWAY_SIGN_IN_TIMEOUT_MESSAGE = "Sign-in didn't finish.";

const GatewayModelAccessContext = createContext<GatewayModelAccess>({
  options: [], disabledProviders: noDisabledProviders, signIn: null,
  select: (option, commit, isCurrent) => {
    if (!option.disabled && !option.gatewayAuthorization && isCurrent()) commit();
    return () => undefined;
  },
  signInProvider: () => undefined,
  providerFor: () => null,
  cancel: () => undefined,
});

/**
 * Owns sign-in for gateway providers that use each member's own account.
 * Sign-in happens where the person already is: the provider group in the
 * model picker shows the waiting state, and the clicked model is picked once
 * the provider confirms. No dialog.
 */
export function GatewayModelAccessProvider(props: {
  providers: GatewayConnectProvider[];
  disabledProviders?: readonly string[];
  scopeKey: string;
  login: GatewayModelLogin;
  selectionRef?: Ref<GatewayModelSelectionHandle>;
  children: ReactNode;
}) {
  const [signIn, setSignIn] = useState<GatewaySignInState | null>(null);
  const attemptRef = useRef<Attempt | null>(null);
  const scope = useRef(props.scopeKey);
  scope.current = props.scopeKey;
  const disabledProviders = props.disabledProviders ?? noDisabledProviders;
  const disabled = useRef(disabledProviders);
  disabled.current = disabledProviders;
  const providersRef = useRef(props.providers);
  providersRef.current = props.providers;
  const loginRef = useRef(props.login);
  loginRef.current = props.login;
  const options = useMemo(() => markDisabledModelOptions(pendingGatewayModelOptions(props.providers), disabledProviders), [props.providers, disabledProviders]);

  const cancel = useCallback(() => {
    attemptRef.current?.controller.abort();
    attemptRef.current?.releaseDefaultRepair();
    attemptRef.current = null;
    setSignIn(null);
  }, []);

  useLayoutEffect(() => cancel, [props.scopeKey, cancel]);
  useLayoutEffect(() => {
    const attempt = attemptRef.current;
    if (!attempt) return;
    const provider = providersRef.current.find((entry) => gatewayConnectProviderKey(entry) === attempt.providerKey);
    if (provider && disabledProviders.includes(provider.providerId)) cancel();
  }, [disabledProviders, cancel]);
  useEffect(() => {
    window.addEventListener(denSessionUpdatedEvent, cancel);
    window.addEventListener(denSettingsChangedEvent, cancel);
    return () => {
      window.removeEventListener(denSessionUpdatedEvent, cancel);
      window.removeEventListener(denSettingsChangedEvent, cancel);
    };
  }, [cancel]);

  const run = useCallback(async (provider: GatewayConnectProvider, model: ModelRef | null, commit: (() => void) | null, isCurrent: () => boolean) => {
    cancel();
    const providerKey = gatewayConnectProviderKey(provider);
    const attempt: Attempt = { providerKey, controller: new AbortController(), releaseDefaultRepair: beginPendingGatewayModelSelection() };
    attemptRef.current = attempt;
    setSignIn({ kind: "waiting", providerKey, modelId: model?.modelID ?? null });
    const scopeKey = scope.current;
    const stillCurrent = () => attemptRef.current === attempt && !attempt.controller.signal.aborted && scope.current === scopeKey
      && !disabled.current.includes(provider.providerId) && isCurrent();
    let connected = false;
    let failure = GATEWAY_SIGN_IN_TIMEOUT_MESSAGE;
    try {
      connected = await loginRef.current(provider, attempt.controller.signal, model ?? undefined);
    } catch (error) {
      connected = false;
      if (error instanceof Error && error.message.trim()) failure = error.message;
    }
    if (attemptRef.current !== attempt || attempt.controller.signal.aborted) return;
    const shouldCommit = connected && commit !== null && stillCurrent();
    attempt.releaseDefaultRepair();
    attemptRef.current = null;
    if (!connected) {
      setSignIn({ kind: "failed", providerKey, message: failure });
      return;
    }
    setSignIn(null);
    toast.success(`Signed in to ${gatewaySignInBrand(provider)}`);
    if (shouldCommit) commit?.();
  }, [cancel]);

  const select = useCallback<GatewayModelAccess["select"]>((option, commit, isCurrent) => {
    if (option.disabled || disabled.current.includes(option.providerID) || !isCurrent()) return () => undefined;
    const provider = findWaitingProvider(providersRef.current, option);
    if (!provider) {
      if (!option.gatewayAuthorization && isCurrent()) commit();
      return () => undefined;
    }
    void run(provider, { providerID: option.providerID, modelID: option.modelID }, commit, isCurrent);
    const providerKey = gatewayConnectProviderKey(provider);
    return () => {
      if (attemptRef.current?.providerKey === providerKey) cancel();
    };
  }, [cancel, run]);

  const signInProvider = useCallback((provider: GatewayConnectProvider) => {
    if (disabled.current.includes(provider.providerId)) return;
    void run(provider, null, null, () => true);
  }, [run]);

  const providerFor = useCallback((model: ModelRef) => findWaitingProvider(props.providers, model), [props.providers]);

  useImperativeHandle(props.selectionRef, () => ({ select }), [select]);

  return (
    <GatewayModelAccessContext value={{ options, disabledProviders, signIn, select, signInProvider, providerFor, cancel }}>
      {props.children}
    </GatewayModelAccessContext>
  );
}

export function useGatewayModelSelection(contextKey: string) {
  const access = useContext(GatewayModelAccessContext);
  const epoch = useMemo(() => ({}), [contextKey]);
  const current = useRef(epoch);
  current.current = epoch;
  const release = useRef<(() => void) | null>(null);
  // Closing the picker or changing the model it was opened for stops a sign-in
  // that would otherwise pick a model the person has moved on from.
  useLayoutEffect(() => {
    current.current = epoch;
    return () => { current.current = {}; release.current?.(); release.current = null; };
  }, [epoch]);
  const select = useCallback((option: ModelOption, commit: () => void) => {
    release.current?.();
    release.current = access.select(option, commit, () => current.current === epoch);
  }, [access.select, epoch]);
  return {
    options: access.options,
    disabledProviders: access.disabledProviders,
    signIn: access.signIn,
    signInProvider: access.signInProvider,
    providerFor: access.providerFor,
    cancel: access.cancel,
    select,
  };
}
