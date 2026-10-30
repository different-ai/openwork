import { Pin, PinOff } from "lucide-react";
import { markFeatureUsed } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { useBuiltDashboardApps } from "../dashboard/built-dashboard-apps";
import { useDesktopFeature } from "../session/status/use-desktop-feature";

/** Feature-off previews keep their existing header and do not fetch a catalog. */
export function BuiltAppPinButton({ appId }: { appId: string }) {
  return useDesktopFeature("artifactsListFirst") ? <BuiltAppPinControl appId={appId} /> : null;
}

function BuiltAppPinControl({ appId }: { appId: string }) {
  const built = useBuiltDashboardApps();
  const pinned = built.ids.includes(appId);
  const available = built.ready && built.apps.some(app => app.connectionId === appId);
  const reason = !built.identityVerified
    ? "Sign in to pin artifacts."
    : built.query.isError
      ? "Couldn't verify access. Refresh Artifacts and try again."
      : !built.query.isSuccess
        ? "Checking artifact access."
        : !available
          ? "This artifact isn't available in your catalog."
          : undefined;
  const Icon = pinned ? PinOff : Pin;
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={pinned}
      disabled={!available}
      title={reason}
      onClick={() => {
        if (!available) return;
        markFeatureUsed("artifactsListFirst");
        built.setAdded(appId, !pinned);
      }}
    >
      <Icon className="size-4" />
      {pinned ? "Unpin" : "Pin"}
    </Button>
  );
}
