import { createContext, useContext, type Accessor, type ParentProps } from "solid-js";

import type { ProviderListItem } from "../types";
import type {
  ProviderAuthMethod,
  ProviderOAuthStartResult,
} from "../components/provider-auth-modal";

export type ProviderAuthContextValue = {
  providers: Accessor<ProviderListItem[]>;
  providerConnectedIds: Accessor<string[]>;
  providerAuthBusy: Accessor<boolean>;
  providerAuthModalOpen: Accessor<boolean>;
  providerAuthError: Accessor<string | null>;
  providerAuthMethods: Accessor<Record<string, ProviderAuthMethod[]>>;
  providerAuthPreferredProviderId: Accessor<string | null>;
  providerAuthWorkerType: Accessor<"local" | "remote">;
  openProviderAuthModal: (options?: {
    returnFocusTarget?: "none" | "composer";
    preferredProviderId?: string;
  }) => Promise<void>;
  closeProviderAuthModal: (options?: { restorePromptFocus?: boolean }) => void;
  startProviderAuth: (
    providerId?: string,
    methodIndex?: number,
  ) => Promise<ProviderOAuthStartResult>;
  completeProviderAuthOAuth: (
    providerId: string,
    methodIndex: number,
    code?: string,
  ) => Promise<{ connected: boolean; pending?: boolean; message?: string }>;
  submitProviderApiKey: (
    providerId: string,
    apiKey: string,
  ) => Promise<string | void>;
  disconnectProvider: (providerId: string) => Promise<string | void>;
  refreshProviders: () => Promise<unknown>;
};

const ProviderAuthContext = createContext<ProviderAuthContextValue | undefined>(undefined);

export function ProviderAuthProvider(props: ParentProps<{ value: ProviderAuthContextValue }>) {
  return (
    <ProviderAuthContext.Provider value={props.value}>
      {props.children}
    </ProviderAuthContext.Provider>
  );
}

export function useProviderAuth() {
  const context = useContext(ProviderAuthContext);
  if (!context) {
    throw new Error("Provider auth context is missing");
  }
  return context;
}
