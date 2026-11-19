import { createContext, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import type { ModelOption, ModelRef } from "@/app/types";
import { denSessionUpdatedEvent, denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { gatewayConnectProviderKey, pendingGatewayModelOptions, type GatewayConnectProvider } from "./cloud-provider-config";
import { beginPendingGatewayModelSelection } from "./pending-gateway-model-selection";
import { markDisabledModelOptions } from "./assigned-model-options";

const noDisabledProviders: readonly string[] = [];

export type GatewayModelLogin = (provider: GatewayConnectProvider, signal: AbortSignal, model: ModelRef) => Promise<boolean>;

type Selection = {
  option: ModelOption;
  provider: GatewayConnectProvider;
  controller: AbortController;
  commit: () => void;
  isCurrent: () => boolean;
  releaseDefaultRepair: () => void;
};

type GatewayModelAccess = {
  options: ModelOption[];
  disabledProviders: readonly string[];
  loginOpen: boolean;
  select: (option: ModelOption, commit: () => void, isCurrent: () => boolean) => () => void;
};

export type GatewayModelSelectionHandle = Pick<GatewayModelAccess, "select">;

const GatewayModelAccessContext = createContext<GatewayModelAccess>({
  options: [], disabledProviders: noDisabledProviders, loginOpen: false,
  select: (option, commit, isCurrent) => {
    if (!option.disabled && !option.gatewayAuthorization && isCurrent()) commit();
    return () => undefined;
  },
});

export function GatewayModelAccessProvider(props: {
  providers: GatewayConnectProvider[];
  disabledProviders?: readonly string[];
  scopeKey: string;
  login: GatewayModelLogin;
  selectionRef?: Ref<GatewayModelSelectionHandle>;
  children: ReactNode;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = useRef(props.scopeKey);
  scope.current = props.scopeKey;
  const disabledProviders = props.disabledProviders ?? noDisabledProviders;
  const disabled = useRef(disabledProviders);
  disabled.current = disabledProviders;
  const options = useMemo(() => markDisabledModelOptions(pendingGatewayModelOptions(props.providers), disabledProviders), [props.providers, disabledProviders]);
  const cancel = useCallback(() => {
    selectionRef.current?.controller.abort();
    selectionRef.current?.releaseDefaultRepair();
    selectionRef.current = null;
    setSelection(null);
    setBusy(false);
    setError(null);
  }, []);

  useLayoutEffect(() => {
    cancel();
    return cancel;
  }, [props.scopeKey, cancel]);
  useLayoutEffect(() => {
    if (selectionRef.current && disabledProviders.includes(selectionRef.current.option.providerID)) cancel();
  }, [disabledProviders, cancel]);
  useEffect(() => {
    window.addEventListener(denSessionUpdatedEvent, cancel);
    window.addEventListener(denSettingsChangedEvent, cancel);
    return () => {
      window.removeEventListener(denSessionUpdatedEvent, cancel);
      window.removeEventListener(denSettingsChangedEvent, cancel);
    };
  }, [cancel]);

  const select = useCallback<GatewayModelAccess["select"]>((option, commit, isCurrent) => {
    cancel();
    if (option.disabled || disabled.current.includes(option.providerID) || !isCurrent()) return () => undefined;
    const provider = props.providers.find((entry) => entry.providerId === option.providerID
      && entry.models?.some((model) => model.id === option.modelID && model.credentialSetId === entry.credentialSetId));
    if (!provider) {
      if (!option.disabled && !option.gatewayAuthorization && isCurrent()) commit();
      return () => undefined;
    }
    const scopeKey = props.scopeKey;
    const next: Selection = {
      option, provider, commit, controller: new AbortController(),
      releaseDefaultRepair: beginPendingGatewayModelSelection(),
      isCurrent: () => scope.current === scopeKey && !disabled.current.includes(option.providerID) && isCurrent(),
    };
    selectionRef.current = next;
    setSelection(next);
    return () => {
      if (selectionRef.current === next) cancel();
    };
  }, [cancel, props.providers, props.scopeKey]);

  useImperativeHandle(props.selectionRef, () => ({ select }), [select]);

  const login = async () => {
    const pending = selectionRef.current;
    if (!pending || busy) return;
    if (!pending.isCurrent()) { cancel(); return; }
    const stillAssigned = props.providers.some((provider) => gatewayConnectProviderKey(provider) === gatewayConnectProviderKey(pending.provider)
      && provider.models?.some((model) => model.id === pending.option.modelID));
    if (!stillAssigned) { cancel(); return; }
    setBusy(true);
    setError(null);
    try {
      const connected = await props.login(pending.provider, pending.controller.signal, pending.option);
      if (pending.controller.signal.aborted || selectionRef.current !== pending) return;
      if (!pending.isCurrent()) { cancel(); return; }
      if (connected) {
        cancel();
        pending.commit();
      } else {
        setError("Sign-in has not been confirmed. Retry Login or Cancel.");
      }
    } catch {
      if (!pending.controller.signal.aborted && pending.isCurrent()) setError("Sign-in failed. Retry Login or Cancel.");
    } finally {
      if (selectionRef.current === pending) setBusy(false);
    }
  };

  return (
    <GatewayModelAccessContext value={{ options, disabledProviders, loginOpen: selection !== null, select }}>
      {props.children}
      <Dialog open={selection !== null} onOpenChange={(open) => { if (!open) cancel(); }}>
        <DialogContent className="lg:max-w-sm" showCloseButton={false}>
          <DialogHeader><DialogTitle>Log in to this provider to use the models</DialogTitle></DialogHeader>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={cancel}>Cancel</Button>
            <Button disabled={busy} onClick={() => void login()}>Login</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </GatewayModelAccessContext>
  );
}

export function useGatewayModelSelection(contextKey: string) {
  const access = useContext(GatewayModelAccessContext);
  const epoch = useMemo(() => ({}), [contextKey]);
  const current = useRef(epoch);
  current.current = epoch;
  const cancel = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    current.current = epoch;
    return () => { current.current = {}; cancel.current?.(); };
  }, [epoch]);
  const select = useCallback((option: ModelOption, commit: () => void) => {
    cancel.current?.();
    cancel.current = access.select(option, commit, () => current.current === epoch);
  }, [access.select, epoch]);
  return { options: access.options, disabledProviders: access.disabledProviders, loginOpen: access.loginOpen, select };
}
