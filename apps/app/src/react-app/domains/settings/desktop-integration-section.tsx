/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { desktopBridge } from "@/app/lib/desktop";
import { t } from "@/i18n";
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
    return t("desktop.status_integrated");
  }
  if (status.state === "managed_externally") {
    return t("desktop.status_managed_external");
  }
  if (status.state === "needs_repair" && status.ownership === "external") {
    return status.issues.includes("desktop-entry")
      ? t("desktop.status_repair_external_entry")
      : t("desktop.status_repair_external_other");
  }
  if (status.state === "needs_repair") {
    return t("desktop.status_repair");
  }
  return t("desktop.status_add");
}

function statusLabel(status: DesktopIntegrationStatus) {
  if (status.state === "integrated") return t("desktop.integrated");
  if (status.state === "managed_externally") return t("desktop.managed_by_other");
  if (status.state === "needs_repair") return t("desktop.needs_repair");
  return t("desktop.not_integrated");
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
      if (!result.ok) setError(result.error ?? t("desktop.failed"));
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
        <LayoutSectionTitle>{t("desktop.appimage_title")}</LayoutSectionTitle>
        <LayoutSectionDescription>
          {t("desktop.appimage_desc")}
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
                {t("desktop.integrate")}
              </Button>
            ) : null}
            {openworkManaged ? (
              <>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(() => desktopBridge.desktopIntegrationInstall())}
                >
                  {t("desktop.repair")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run(() => desktopBridge.desktopIntegrationRemove())}
                >
                  {t("desktop.remove")}
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
                {t("desktop.use_manager_launcher")}
              </Button>
            ) : null}
            {externallyManaged ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>
                {t("desktop.recheck")}
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
