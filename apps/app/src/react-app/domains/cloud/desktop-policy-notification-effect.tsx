/** @jsxImportSource react */
import { useEffect, useRef } from "react";
import { desktopPolicyKeys } from "@openwork/types/den/desktop-policies";

import { useNotificationStore } from "../../kernel/notification-store";
import { useOrgRestrictions } from "./desktop-config-provider";

const POLICY_NOTIFICATION_DEDUPE = "desktop-policy-active";

/** Notifies once per mount when an organization desktop restriction is active. */
export function DesktopPolicyNotificationEffect() {
  const config = useOrgRestrictions();
  const firedRef = useRef(false);
  const addNotification = useNotificationStore((state) => state.add);

  useEffect(() => {
    if (firedRef.current) return;
    if (!desktopPolicyKeys.some((key) => config[key] === false)) return;

    firedRef.current = true;
    addNotification({
      kind: "cloud",
      severity: "info",
      title: "Organization policies active",
      body: "Some features are managed by your administrator.",
      dedupeKey: POLICY_NOTIFICATION_DEDUPE,
    });
  }, [config, addNotification]);

  return null;
}
