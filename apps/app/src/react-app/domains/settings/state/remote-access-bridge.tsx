import { useEffect } from "react";
import { createDenClient, readDenSettings } from "@/app/lib/den";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { remoteAccessFeatureSession } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { useEnterpriseActivationRequired } from "@/react-app/domains/cloud/enterprise-activation-gate";

/** Bind account context once globally, so saved remote access works with Settings closed. */
export function RemoteAccessBridge() {
  const { status } = useDenAuth();
  const activationRequired = useEnterpriseActivationRequired();
  useEffect(() => {
    if (!isDesktopRuntime() || activationRequired) return;
    const synchronize = () => {
      const settings = readDenSettings();
      const token = settings.authToken?.trim();
      const orgId = settings.activeOrgId?.trim();
      const context =
        status === "checking" || (token && !orgId)
          ? { pending: true as const }
          : token && orgId
            ? {
                baseUrl: createDenClient({ baseUrl: settings.baseUrl, token })
                  .baseUrls.apiBaseUrl,
                token,
                orgId,
              }
            : null;
      void remoteAccessFeatureSession(context).catch(() => undefined);
    };
    synchronize();
    window.addEventListener(denSettingsChangedEvent, synchronize);
    window.addEventListener("online", synchronize);
    return () => {
      window.removeEventListener(denSettingsChangedEvent, synchronize);
      window.removeEventListener("online", synchronize);
      void remoteAccessFeatureSession({ pending: true }).catch(() => undefined);
    };
  }, [status, activationRequired]);
  return null;
}
