/** @jsxImportSource react */
import { useCallback, useMemo, useState } from "react";
import { installConfigSchema, parseInstallLinkInput } from "@openwork/install-config";

import { clearDenSession, readDenBootstrapConfig, readDenSettings, setDenBootstrapConfig } from "@/app/lib/den";
import { parseManualAuthInput } from "@/app/lib/manual-auth-input";
import { exchangeHandoffAndSignIn } from "@/app/lib/den-handoff";
import { desktopFetchViaMain } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/utils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { usePlatform } from "../../kernel/platform";
import { saveControlPlaneUrl } from "../settings/cloud/control-plane-url";
import { parseInviteLinkInput, parseServerUrlInput, type ParsedInviteLink } from "./join-organization-input";

type JoinOrganizationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
};

type ConnectionStatus =
  | { phase: "idle" }
  | { phase: "connecting"; clientName: string; host: string }
  | { phase: "success"; clientName: string; host: string }
  | { phase: "invite-opened"; host: string }
  | { phase: "server-saved"; host: string };

function hostFromUrl(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
}

function fetchInstallConfig(url: string) {
  const init = { headers: { accept: "application/json" } };
  return isDesktopRuntime()
    ? desktopFetchViaMain(url, init, 10_000)
    : globalThis.fetch(url, init);
}

export function JoinOrganizationDialog({
  open,
  onOpenChange,
  onConnected,
}: JoinOrganizationDialogProps) {
  const platform = usePlatform();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>({ phase: "idle" });
  const [pendingInvite, setPendingInvite] = useState<ParsedInviteLink | null>(null);
  const trimmedInput = input.trim();
  const statusMessage = useMemo(() => {
    if (status.phase === "connecting") {
      return t("join_org.connecting", {
        clientName: status.clientName,
        host: status.host,
      });
    }
    if (status.phase === "success") {
      return t("join_org.success", {
        clientName: status.clientName,
        host: status.host,
      });
    }
    if (status.phase === "invite-opened") {
      return t("join_org.invite_opened", { host: status.host });
    }
    if (status.phase === "server-saved") {
      return t("join_org.server_saved", { host: status.host });
    }
    return null;
  }, [status]);

  const reset = useCallback(() => {
    setError(null);
    setStatus({ phase: "idle" });
  }, []);

  const finishConnected = useCallback(() => {
    if (typeof window === "undefined") {
      onConnected();
      return;
    }
    window.setTimeout(onConnected, 600);
  }, [onConnected]);

  const submitInstallLink = useCallback(async (value: string) => {
    const parsed = parseInstallLinkInput(value);
    if (!parsed) return false;

    let response: Response;
    try {
      response = await fetchInstallConfig(parsed.url);
    } catch {
      setError(t("join_org.error_network"));
      return true;
    }

    if (response.status === 404) {
      setError(t("join_org.error_expired"));
      return true;
    }
    if (!response.ok) {
      setError(t("join_org.error_network"));
      return true;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      setError(t("join_org.error_invalid_config"));
      return true;
    }
    const result = installConfigSchema.safeParse(payload);
    if (!result.success) {
      setError(t("join_org.error_invalid_config"));
      return true;
    }

    const config = result.data;
    const host = hostFromUrl(config.webUrl);
    setStatus({ phase: "connecting", clientName: config.clientName, host });
    await setDenBootstrapConfig({
      baseUrl: config.webUrl,
      requireSignin: config.requireSignin,
      // Joining an organization must not silently rewrite activation policy in
      // either direction — dropping this re-gates an enterprise app an admin
      // unlocked, and clears a gate an admin turned on for a public artifact.
      requireActivation: readDenBootstrapConfig().requireActivation,
      brandAppName: config.appName,
      ...(config.logoUrl ? { brandLogoUrl: config.logoUrl } : {}),
      ...(config.iconUrl ? { brandIconUrl: config.iconUrl } : {}),
    });
    setStatus({ phase: "success", clientName: config.clientName, host });
    finishConnected();
    return true;
  }, [finishConnected]);

  const submitInviteLink = useCallback(async (value: string) => {
    const parsed = parseInviteLinkInput(value);
    if (!parsed) return false;

    setPendingInvite(parsed);
    return true;
  }, []);

  const confirmInviteLink = useCallback(async () => {
    if (!pendingInvite) return;
    const invite = pendingInvite;
    setBusy(true);
    setPendingInvite(null);
    const persisted = await saveControlPlaneUrl(invite.origin);
    if (!persisted) {
      setError(t("join_org.error_invalid"));
      setBusy(false);
      return;
    }
    clearDenSession({ includeBaseUrls: false });
    platform.openLink(invite.url);
    setStatus({ phase: "invite-opened", host: invite.host });
    setBusy(false);
  }, [pendingInvite, platform]);

  const submitServerUrl = useCallback(async (value: string) => {
    const parsed = parseServerUrlInput(value);
    if (!parsed) return false;

    const persisted = await saveControlPlaneUrl(parsed.url);
    if (!persisted) {
      setError(t("join_org.error_invalid"));
      return true;
    }
    clearDenSession({ includeBaseUrls: false });
    setStatus({ phase: "server-saved", host: hostFromUrl(persisted.baseUrl) });
    return true;
  }, []);

  const submitManualAuth = useCallback(async (value: string) => {
    const parsed = parseManualAuthInput(value);
    if (!parsed) return false;

    const settings = readDenSettings();
    const baseUrl = parsed.baseUrl ?? settings.baseUrl;
    setStatus({ phase: "connecting", clientName: t("join_org.openwork_cloud"), host: hostFromUrl(baseUrl) });
    const result = await exchangeHandoffAndSignIn(parsed.grant, {
      baseUrl,
      // Pasted one-time codes are desktop-initiated sign-ins.
      desktopInitiated: true,
      fallbackErrorMessage: t("den.error_no_token"),
    });

    if (!result.ok) {
      setError(result.error);
      return true;
    }

    setStatus({ phase: "success", clientName: t("join_org.openwork_cloud"), host: hostFromUrl(baseUrl) });
    finishConnected();
    return true;
  }, [finishConnected]);

  const submit = useCallback(async () => {
    if (!trimmedInput || busy) return;
    setBusy(true);
    reset();
    try {
      // Install links first (most specific), then web invites, then plain
      // server URLs, and finally pasted sign-in codes. Server URLs require an
      // explicit http(s) scheme, so raw grants never misclassify.
      if (await submitInstallLink(trimmedInput)) return;
      if (await submitInviteLink(trimmedInput)) return;
      if (await submitServerUrl(trimmedInput)) return;
      if (await submitManualAuth(trimmedInput)) return;
      setError(t("join_org.error_invalid"));
    } finally {
      setBusy(false);
    }
  }, [busy, reset, submitInstallLink, submitInviteLink, submitServerUrl, submitManualAuth, trimmedInput]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("join_org.title")}</DialogTitle>
          <DialogDescription>{t("join_org.description")}</DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="join-organization-input">{t("join_org.input_label")}</FieldLabel>
            <Input
              id="join-organization-input"
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                if (error) setError(null);
              }}
              placeholder={t("join_org.input_placeholder")}
              aria-invalid={error ? true : undefined}
              disabled={busy}
            />
            <FieldDescription>{t("join_org.input_hint")}</FieldDescription>
          </Field>
        </FieldGroup>

        {statusMessage ? (
          <Alert>
            <AlertDescription>{statusMessage}</AlertDescription>
          </Alert>
        ) : null}

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={submit} disabled={busy || !trimmedInput}>
            {busy ? t("join_org.connecting_button") : t("join_org.connect_button")}
          </Button>
        </DialogFooter>
      </DialogContent>
      <AlertDialog
        open={Boolean(pendingInvite)}
        onOpenChange={(next) => {
          if (!next) setPendingInvite(null);
        }}
      >
        <AlertDialogContent data-testid="join-invite-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("join_org.confirm_invite_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingInvite ? t("join_org.confirm_invite_body", { host: pendingInvite.host }) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="join-invite-confirm-cancel">
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="join-invite-confirm-accept"
              onClick={() => void confirmInviteLink()}
            >
              {t("join_org.confirm_invite_cta")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
