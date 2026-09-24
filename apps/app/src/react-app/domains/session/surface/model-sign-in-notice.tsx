/** @jsxImportSource react */
import { Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/react-app/design-system/provider-icon";
import { gatewayConnectProviderKey, gatewaySignInBrand } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { useGatewayModelSelection } from "@/react-app/domains/connections/provider-auth/gateway-model-access";
import { dismissModelSignInNotice, useModelSignInNoticeStore } from "@/react-app/domains/connections/provider-auth/model-sign-in-notice";

/**
 * Above the composer on a first chat: the model the company picked needs this
 * person's sign-in. It never blocks work; the composer already uses a model
 * that works.
 */
export function ModelSignInNotice() {
  const notice = useModelSignInNoticeStore((state) => state.notice);
  const setNotice = useModelSignInNoticeStore((state) => state.setNotice);
  const selection = useGatewayModelSelection("model-sign-in-notice");
  if (!notice) return null;
  const brand = gatewaySignInBrand(notice.provider);
  const signIn = selection.signIn?.providerKey === gatewayConnectProviderKey(notice.provider) ? selection.signIn : null;
  const whose = notice.organizationName ? `, ${notice.organizationName}'s default,` : ", your company's default,";
  return (
    <div data-testid="model-sign-in-notice" className="mx-3 mb-2 flex items-center gap-3 rounded-lg border border-dls-border bg-dls-surface px-3 py-2 text-xs text-dls-text">
      <ProviderIcon providerId={notice.provider.providerId} providerName={notice.provider.name} size={16} className="shrink-0" />
      <p className="min-w-0 flex-1">
        {signIn?.kind === "waiting"
          ? "Finish signing in in your browser."
          : signIn?.kind === "failed"
            ? signIn.message
            : `${notice.modelName}${whose} needs your ${brand} sign-in.`}
      </p>
      {signIn?.kind === "waiting" ? (
        <>
          <Loader2 size={13} className="shrink-0 animate-spin text-dls-secondary" />
          <Button size="sm" variant="ghost" onClick={selection.cancel}>Cancel</Button>
        </>
      ) : (
        <Button size="sm" variant="outline" onClick={() => selection.signInProvider(notice.provider)}>
          {signIn?.kind === "failed" ? "Try again" : `Sign in with ${brand}`}
        </Button>
      )}
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Dismiss"
        onClick={() => {
          dismissModelSignInNotice(notice.dismissKey);
          setNotice(null);
        }}
      >
        <X size={14} />
      </Button>
    </div>
  );
}
