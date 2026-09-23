"use memo";

import * as React from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/react-app/design-system/provider-icon";
import {
  gatewayConnectProviderKey,
  gatewaySignInBrand,
  type GatewayConnectProvider,
} from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { useGatewayModelSelection } from "@/react-app/domains/connections/provider-auth/gateway-model-access";
import { useMessageList } from "@/components/chat/message-list-provider";

/** The last message the person sent, so a failed answer can be asked again. */
export const LatestUserMessageContext = React.createContext<{ id: string; text: string } | null>(null);

/**
 * Mid-chat: the provider signed the person out, so the model couldn't answer.
 * One neutral line with the two ways forward, right where the answer would
 * have been. Either one sends the message again.
 */
export function GatewaySignedOutMessage(props: {
  authorization: { cloudProviderId: string; credentialSetId: string; providerHint?: string } | null;
  canRetry: boolean;
}) {
  const { modelLabel, fallbackModel, onResumeInterrupted, sessionId } = useMessageList();
  const latest = React.useContext(LatestUserMessageContext);
  const selection = useGatewayModelSelection(`signed-out:${sessionId}`);
  const [resendAfterSignIn, setResendAfterSignIn] = React.useState(false);
  const authorization = props.authorization;
  const known = authorization
    ? selection.options.find((option) => option.gatewayAuthorization
      && gatewayConnectProviderKey(option.gatewayAuthorization) === gatewayConnectProviderKey(authorization))
    : undefined;
  const provider: GatewayConnectProvider | null = authorization ? {
    cloudProviderId: authorization.cloudProviderId,
    credentialSetId: authorization.credentialSetId,
    providerId: known?.providerID ?? authorization.cloudProviderId,
    name: known?.description ?? (authorization.providerHint ? authorization.providerHint.charAt(0).toUpperCase() + authorization.providerHint.slice(1) : "your account"),
    authUrl: null,
  } : null;
  const brand = provider && provider.name !== "your account" ? gatewaySignInBrand(provider) : "Your provider";
  const signIn = provider && selection.signIn?.providerKey === gatewayConnectProviderKey(provider) ? selection.signIn : null;
  const resend = React.useCallback(() => {
    if (latest?.text && onResumeInterrupted) onResumeInterrupted(latest.text);
  }, [latest?.text, onResumeInterrupted]);

  // Signing in again sends the failed message again once the provider confirms.
  const wasWaiting = React.useRef(false);
  React.useEffect(() => {
    if (signIn?.kind === "waiting") {
      wasWaiting.current = true;
      return;
    }
    if (wasWaiting.current && resendAfterSignIn && signIn === null) resend();
    wasWaiting.current = false;
    if (signIn === null || signIn.kind === "failed") setResendAfterSignIn(false);
  }, [resend, resendAfterSignIn, signIn]);

  const who = brand === "Your provider" ? "Your provider" : brand;
  const what = modelLabel?.trim() || "this model";
  return (
    <div data-testid="session-error-signed-out" className="flex flex-wrap items-center gap-2 py-1 text-sm text-dls-text">
      {provider ? <ProviderIcon providerId={provider.providerId} providerName={provider.name} size={16} className="shrink-0" /> : null}
      <span className="min-w-0 flex-1">
        {signIn?.kind === "waiting"
          ? "Finish signing in in your browser."
          : signIn?.kind === "failed"
            ? signIn.message
            : `${who} signed you out, so ${what} couldn't answer.`}
      </span>
      {signIn?.kind === "waiting" ? (
        <>
          <Loader2 size={13} className="shrink-0 animate-spin text-dls-secondary" />
          <Button variant="ghost" size="xs" onClick={() => { setResendAfterSignIn(false); selection.cancel(); }}>Cancel</Button>
        </>
      ) : (
        <>
          {provider && props.canRetry ? (
            <Button variant="outline" size="xs" data-testid="session-error-sign-in-again" onClick={() => {
              setResendAfterSignIn(true);
              selection.signInProvider(provider);
            }}>
              {signIn?.kind === "failed" ? "Try again" : "Sign in again"}
            </Button>
          ) : null}
          {fallbackModel && props.canRetry ? (
            <Button variant="ghost" size="xs" data-testid="session-error-use-fallback" onClick={() => {
              fallbackModel.use();
              // Let the model switch land before asking again.
              window.setTimeout(resend, 0);
            }}>
              {`Use ${fallbackModel.label}`}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
