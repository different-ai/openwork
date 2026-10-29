import type { QueryClient } from "@tanstack/react-query";
import type { ActivationState } from "@openwork/types/den/activation";

/** Bind event reporting to the exact query authenticated by useActivation, never an organization's query prefix. */
export function createActivationCache<Scope extends object>(client: () => QueryClient) {
  const bindings = new WeakMap<Scope, readonly unknown[]>();
  return {
    bind(scope: Scope, queryKey: readonly unknown[]) {
      bindings.set(scope, queryKey);
      return () => {
        if (bindings.get(scope) === queryKey) bindings.delete(scope);
      };
    },
    key(scope: Scope) {
      return bindings.get(scope);
    },
    read(scope: Scope) {
      const queryKey = bindings.get(scope);
      return queryKey ? client().getQueryData<ActivationState | null>(queryKey) : undefined;
    },
    write(scope: Scope, state: ActivationState, expectedKey = bindings.get(scope)) {
      const queryKey = bindings.get(scope);
      if (queryKey && queryKey === expectedKey) client().setQueryData<ActivationState | null>(queryKey, state);
    },
  };
}
