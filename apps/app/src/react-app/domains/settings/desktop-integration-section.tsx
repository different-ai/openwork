/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { desktopBridge } from "@/app/lib/desktop";
import type {
  DesktopIntegrationResult,
  DesktopIntegrationStatus,
} from "@/app/lib/desktop-types";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
} from "./settings-layout";

function statusDescription(status: DesktopIntegrationStatus) {
  if (status.state === "integrated") {
    return "OpenWork is in your application launcher and handles openwork:// browser callbacks.";
  }
  if (status.state === "managed_externally") {
    return "This AppImage is integrated by another app. OpenWork will leave its launcher untouched.";
  }
  if (status.state === "needs_repair" && status.ownership === "external") {
    return status.issues.includes("desktop-entry")
      ? "The manager-owned launcher cannot accept browser callbacks. Re-integrate this AppImage with its manager."
      : "Another app manages this AppImage. Select its launcher for OpenWork browser callbacks.";
  }
  if (status.state === "needs_repair") {
    return "The AppImage moved or its launcher, icon, or browser callback needs repair.";
  }
  return "Add this AppImage to your application launcher and enable browser sign-in callbacks.";
}

function statusLabel(status: DesktopIntegrationStatus) {
  if (status.state === "integrated") return "Integrated";
  if (status.state === "managed_externally") return "Managed by another app";
  if (status.state === "needs_repair") return "Needs repair";
  return "Not integrated";
}

export function DesktopIntegrationSection() {
  const [status, setStatus] = useState<DesktopIntegrationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setStatus(await desktopBridge.desktopIntegrationStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(async (action: () => Promise<DesktopIntegrationResult>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      setStatus(result.status);
      if (!result.ok) setError(result.error ?? "Desktop integration failed.");
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(false);
    }
  }, []);

  if (!status?.supported) return null;

  const externallyManaged = status.ownership === "external";
  const openworkManaged = status.ownership === "openwork";

  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <LayoutSectionTitle>AppImage desktop integration</LayoutSectionTitle>
        <LayoutSectionDescription>
          Control the launcher, icon, and openwork:// callback for this AppImage.
        </LayoutSectionDescription>
      </LayoutSectionHeader>

      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>{statusLabel(status)}</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>{statusDescription(status)}</LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            {status.ownership === "none" ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void run(() => desktopBridge.desktopIntegrationInstall())}
              >
                Integrate
              </Button>
            ) : null}
            {openworkManaged ? (
              <>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(() => desktopBridge.desktopIntegrationInstall())}
                >
                  Repair
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run(() => desktopBridge.desktopIntegrationRemove())}
                >
                  Remove
                </Button>
              </>
            ) : null}
            {externallyManaged && status.state === "needs_repair" ? (
              <Button
                size="sm"
                disabled={busy || status.issues.includes("desktop-entry")}
                onClick={() => void run(() => (
                  desktopBridge.desktopIntegrationInstall({ useExternalLauncher: true })
                ))}
              >
                Use manager launcher
              </Button>
            ) : null}
            {externallyManaged ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>
                Recheck
              </Button>
            ) : null}
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
        <p className="break-all text-xs text-muted-foreground">{status.appImagePath}</p>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </LayoutSectionItem>
    </LayoutSection>
  );
}
