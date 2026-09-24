"use memo";

import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/react-app/design-system/provider-icon";
import type { GatewaySignInState } from "@/react-app/domains/connections/provider-auth/gateway-model-access";

/**
 * The one card a person sees in the chat when their message can't go to the
 * model yet: it names why, says what happens to the message, and offers the
 * ways forward. Used for the first chat, mid-chat sign-outs and missing access.
 */
export function ModelBlockedCard(props: {
  testId: string;
  providerId?: string | null;
  providerName?: string | null;
  title: string;
  detail: string;
  /** "Sign in with Google", "Sign in again"; omitted when signing in can't help. */
  signInLabel?: string | null;
  /** Only this card's provider's sign-in, so another card's progress never shows here. */
  signIn?: GatewaySignInState | null;
  onSignIn?: () => void;
  onCancelSignIn?: () => void;
  onSwitchModel?: () => void;
}) {
  const waiting = props.signIn?.kind === "waiting";
  const failed = props.signIn?.kind === "failed" ? props.signIn.message : null;
  return (
    <div data-testid={props.testId} className="flex gap-3 rounded-xl border border-dls-border bg-dls-surface px-4 py-3">
      {props.providerId ? (
        <ProviderIcon providerId={props.providerId} providerName={props.providerName ?? undefined} size={16} className="mt-0.5 shrink-0" />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm text-dls-text">{props.title}</span>
        <span className="text-[13px] text-dls-secondary">
          {waiting ? "Finish signing in in your browser." : failed ?? props.detail}
        </span>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {waiting ? (
            <>
              <Loader2 size={13} className="shrink-0 animate-spin text-dls-secondary" />
              <Button variant="ghost" size="xs" onClick={props.onCancelSignIn}>Cancel</Button>
            </>
          ) : (
            <>
              {props.signInLabel && props.onSignIn ? (
                <Button variant="outline" size="xs" data-testid={`${props.testId}-sign-in`} onClick={props.onSignIn}>
                  {failed ? "Try again" : props.signInLabel}
                </Button>
              ) : null}
              {props.onSwitchModel ? (
                <Button variant="ghost" size="xs" data-testid={`${props.testId}-switch-model`} onClick={props.onSwitchModel}>Switch model</Button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
