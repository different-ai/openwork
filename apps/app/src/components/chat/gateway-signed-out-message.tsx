"use memo";

import * as React from "react";

import { readDenSettings } from "@/app/lib/den";
import { ModelBlockedCard } from "@/components/chat/model-blocked-card";
import {
  gatewayConnectProviderKey,
  gatewaySignInBrand,
  type GatewayConnectProvider,
} from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { useGatewayModelSelection } from "@/react-app/domains/connections/provider-auth/gateway-model-access";
import { useMessageList } from "@/components/chat/message-list-provider";
import { openModelPickerEvent } from "@/react-app/shell/new-providers-listener";

/** The last message the person sent, so a failed answer can be asked again. */
export const LatestUserMessageContext = React.createContext<{ id: string; text: string } | null>(null);

function openSwitchModel(sessionId: string) {
  window.dispatchEvent(new CustomEvent(openModelPickerEvent, { detail: { sessionId } }));
}

/**
 * Mid-chat: the provider signed the person out, so the model couldn't answer.
 * Signing in again sends the message again once the provider confirms;
 * Switch model opens the picker and picks nothing on its own.
 */
export function GatewaySignedOutMessage(props: {
  authorization: { cloudProviderId: string; credentialSetId: string; providerHint?: string } | null;
  canRetry: boolean;
}) {
  const { modelLabel, onResumeInterrupted, sessionId } = useMessageList();
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
    name: known?.description ?? (authorization.providerHint ? authorization.providerHint.charAt(0).toUpperCase() + authorization.providerHint.slice(1) : ""),
    authUrl: null,
  } : null;
  const brand = provider?.name ? gatewaySignInBrand(provider) : "Your provider";
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

  const what = modelLabel?.trim() || "this model";
  return (
    <ModelBlockedCard
      testId="session-error-signed-out"
      providerId={provider?.providerId}
      providerName={provider?.name}
      title={`${brand} signed you out, so ${what} couldn't answer.`}
      detail={props.canRetry ? "Your message is kept. It sends again once you're signed in." : "Sign in again to keep using it."}
      signInLabel={provider && props.canRetry ? "Sign in again" : null}
      signIn={signIn}
      onSignIn={provider ? () => {
        setResendAfterSignIn(true);
        selection.signInProvider(provider);
      } : undefined}
      onCancelSignIn={() => { setResendAfterSignIn(false); selection.cancel(); }}
      onSwitchModel={props.canRetry ? () => openSwitchModel(sessionId) : undefined}
    />
  );
}

/**
 * The person is signed in, but their own account can't use the model in the
 * company's project. Signing in again can't help; only an admin or another
 * model can.
 */
export function GatewayAccessDeniedMessage(props: { providerId: string; providerName: string; canRetry: boolean }) {
  const { modelLabel, sessionId } = useMessageList();
  const brand = gatewaySignInBrand({ name: props.providerName });
  const organization = readDenSettings().activeOrgName?.trim();
  const what = modelLabel?.trim() || "this model";
  return (
    <ModelBlockedCard
      testId="session-error-no-access"
      providerId={props.providerId}
      providerName={props.providerName}
      title={organization
        ? `Your ${brand} account can't use ${what} in ${organization}'s project.`
        : `Your ${brand} account can't use ${what}.`}
      detail={props.canRetry ? "Your message is kept. Ask your admin for access, or switch model." : "Ask your admin for access, or switch model."}
      onSwitchModel={props.canRetry ? () => openSwitchModel(sessionId) : undefined}
    />
  );
}
