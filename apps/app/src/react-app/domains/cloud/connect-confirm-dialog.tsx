/** @jsxImportSource react */

import type { ConnectLinkClaims, ConnectLinkTransport, ConnectLinkVerifyErrorCode } from "@openwork/types/connect-link";

import { t } from "../../../i18n";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { formatControlPlaneHost } from "../settings/cloud/control-plane-url";

export type ConnectConfirmPhase = "verifying" | "confirm" | "applying" | "error";

export type ConnectConfirmDialogProps = {
  open: boolean;
  phase: ConnectConfirmPhase;
  claims: ConnectLinkClaims | null;
  transport: ConnectLinkTransport | null;
  /** Host currently configured, when the app is already connected somewhere. */
  currentHost: string | null;
  error: { code: ConnectLinkVerifyErrorCode; message: string } | null;
  onConfirm: () => void;
  onDismiss: () => void;
};

function errorCopy(code: ConnectLinkVerifyErrorCode): string {
  switch (code) {
    case "expired":
      return t("connect.error_expired");
    case "unknown_kid":
      return t("connect.error_unknown_kid");
    case "replayed":
      return t("connect.error_replayed");
    case "insecure_url":
      return t("connect.error_insecure_url");
    case "unavailable":
      return t("connect.error_unavailable");
    case "bad_signature":
    case "wrong_audience":
    case "wrong_version":
    case "not_yet_valid":
    case "malformed_claims":
    case "invalid_token":
      return t("connect.error_invalid");
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Confirmation step for a verified connect link. Nothing is written until the
 * user confirms here — the dialog shows exactly which organization and server
 * the app is about to be pointed at.
 */
export function ConnectConfirmDialog({
  open,
  phase,
  claims,
  transport,
  currentHost,
  error,
  onConfirm,
  onDismiss,
}: ConnectConfirmDialogProps) {
  const targetHost = claims ? formatControlPlaneHost(claims.den.baseUrl) : null;
  const switching = Boolean(currentHost && targetHost && currentHost !== targetHost);
  const trustedBrandUrl = transport === "signed" ? claims?.brand.iconUrl ?? claims?.brand.logoUrl : null;
  const logoUrl = trustedBrandUrl && isHttpsUrl(trustedBrandUrl) ? trustedBrandUrl : null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onDismiss(); }}>
      <DialogContent className="sm:max-w-md" data-testid="connect-confirm-dialog">
        {phase === "error" && error ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("connect.error_title")}</DialogTitle>
              <DialogDescription data-testid="connect-error-message">
                {errorCopy(error.code)}
              </DialogDescription>
            </DialogHeader>
            <p className="text-xs text-muted-foreground">{t("connect.error_untouched")}</p>
            <DialogFooter>
              <Button variant="outline" onClick={onDismiss} data-testid="connect-error-dismiss">
                {t("common.close")}
              </Button>
            </DialogFooter>
          </>
        ) : phase === "verifying" ? (
          <DialogHeader>
            <DialogTitle>{t("connect.verifying_title")}</DialogTitle>
            <DialogDescription>{t("connect.verifying_body")}</DialogDescription>
          </DialogHeader>
        ) : claims ? (
          <>
            <DialogHeader>
              <div className="flex items-center gap-3">
                {logoUrl ? (
                  <img src={logoUrl} alt="" className="size-10 rounded-lg" />
                ) : null}
                <DialogTitle data-testid="connect-confirm-org">
                  {t("connect.confirm_title", { appName: claims.brand.appName, org: claims.org.name })}
                </DialogTitle>
              </div>
              <DialogDescription data-testid="connect-confirm-host">
                {switching && currentHost
                  ? t("connect.confirm_switch_body", { current: currentHost, host: targetHost ?? "" })
                  : t("connect.confirm_body", { host: targetHost ?? "" })}
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t("connect.confirm_server_label")}</span>
                <span className="font-medium">{targetHost}</span>
              </div>
              <div className="mt-1 flex justify-between gap-4">
                <span className="text-muted-foreground">{t("connect.confirm_expires_label")}</span>
                <span>{new Date(claims.exp * 1000).toLocaleString()}</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t("connect.confirm_signin_note")}</p>
            <DialogFooter>
              <Button variant="outline" onClick={onDismiss} disabled={phase === "applying"} data-testid="connect-confirm-cancel">
                {t("common.cancel")}
              </Button>
              <Button onClick={onConfirm} disabled={phase === "applying"} data-testid="connect-confirm-accept">
                {phase === "applying" ? t("connect.applying") : t("connect.confirm_cta")}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
