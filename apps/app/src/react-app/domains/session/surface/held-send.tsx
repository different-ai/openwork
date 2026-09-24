"use memo";

import { create } from "zustand";

import type { ModelRef } from "@/app/types";
import { ModelBlockedCard } from "@/components/chat/model-blocked-card";
import {
  gatewayConnectProviderKey,
  gatewaySignInBrand,
  type GatewayConnectProvider,
} from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import type { GatewaySignInState } from "@/react-app/domains/connections/provider-auth/gateway-model-access";
import type { ComposerSessionState } from "./composer-state-store";

/**
 * A message the person sent while the conversation's model still needed
 * their sign-in. It is kept, shown dimmed, and sent once the model works.
 */
export type HeldSend = { composer: ComposerSessionState; model: ModelRef };

export const useHeldSendStore = create<{ held: Record<string, HeldSend> }>(() => ({ held: {} }));

export function holdSend(owner: string, entry: HeldSend) {
  useHeldSendStore.setState((state) => ({ held: { ...state.held, [owner]: entry } }));
}

/** Returns the held message and forgets it, so it is sent at most once. */
export function takeHeldSend(owner: string): HeldSend | null {
  const entry = useHeldSendStore.getState().held[owner] ?? null;
  if (!entry) return null;
  useHeldSendStore.setState((state) => {
    const { [owner]: _released, ...rest } = state.held;
    return { held: rest };
  });
  return entry;
}

/** The dimmed message and the one card under it (first chat, H2). */
export function HeldSendNotice(props: {
  held: HeldSend;
  modelLabel: string;
  provider: GatewayConnectProvider | null;
  signIn: GatewaySignInState | null;
  onSignIn: (provider: GatewayConnectProvider) => void;
  onCancelSignIn: () => void;
  onSwitchModel: () => void;
}) {
  const { provider } = props;
  const text = props.held.composer.draft.trim();
  const files = props.held.composer.attachments.length;
  const brand = provider ? gatewaySignInBrand(provider) : null;
  const signIn = provider && props.signIn?.providerKey === gatewayConnectProviderKey(provider) ? props.signIn : null;
  return (
    <div data-testid="held-send" className="mx-3 mb-3 flex flex-col gap-3">
      <div className="flex justify-end">
        <div data-testid="held-send-message" className="max-w-[85%] whitespace-pre-wrap rounded-3xl bg-muted px-4 py-2.5 text-sm leading-6 text-foreground opacity-60 sm:max-w-[75%]">
          {text || `${files} file${files === 1 ? "" : "s"}`}
        </div>
      </div>
      <ModelBlockedCard
        testId="held-send-card"
        providerId={provider?.providerId}
        providerName={provider?.name}
        title={brand ? `${props.modelLabel} needs your ${brand} sign-in.` : `${props.modelLabel} can't answer yet.`}
        detail={brand ? "Your message is kept. It sends once you're signed in." : "Your message is kept. Switch model to send it."}
        signInLabel={brand ? `Sign in with ${brand}` : null}
        signIn={signIn}
        onSignIn={provider ? () => props.onSignIn(provider) : undefined}
        onCancelSignIn={props.onCancelSignIn}
        onSwitchModel={props.onSwitchModel}
      />
    </div>
  );
}
