/** @jsxImportSource react */
import { useCallback, useMemo, useState } from "react";
import { installConfigSchema, parseInstallLinkInput } from "@openwork/install-config";

import { createDenClient, readDenSettings, setDenBootstrapConfig } from "@/app/lib/den";
import { exchangeHandoffAndSignIn } from "@/app/lib/den-handoff";
import { desktopFetchViaMain } from "@/app/lib/desktop";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { parseManualAuthInput } from "./forced-signin-page";

type JoinOrganizationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
};

type ConnectionStatus =
  | { phase: "idle" }
  | { phase: "connecting"; clientName: string; host: string }
  | { phase: "success"; clientName: string; host: string };

function hostFromUrl(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
}

export function JoinOrganizationDialog({
  open,
  onOpenChange,
  onConnected,
}: JoinOrganizationDialogProps) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>({ phase: "idle" });
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
      response = await desktopFetchViaMain(
        parsed.url,
        { headers: { accept: "application/json" } },
        10_000,
      );
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
      brandAppName: config.appName,
      ...(config.logoUrl ? { brandLogoUrl: config.logoUrl } : {}),
      ...(config.iconUrl ? { brandIconUrl: config.iconUrl } : {}),
    });
    setStatus({ phase: "success", clientName: config.clientName, host });
    finishConnected();
    return true;
  }, [finishConnected]);

  const submitManualAuth = useCallback(async (value: string) => {
    const parsed = parseManualAuthInput(value);
    if (!parsed) return false;

    const baseUrl = parsed.baseUrl ?? readDenSettings().baseUrl;
    setStatus({ phase: "connecting", clientName: t("join_org.openwork_cloud"), host: hostFromUrl(baseUrl) });
    const result = await exchangeHandoffAndSignIn(parsed.grant, {
      baseUrl,
      client: createDenClient({ baseUrl }),
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
      if (await submitInstallLink(trimmedInput)) return;
      if (await submitManualAuth(trimmedInput)) return;
      setError(t("join_org.error_invalid"));
    } finally {
      setBusy(false);
    }
  }, [busy, reset, submitInstallLink, submitManualAuth, trimmedInput]);

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
    </Dialog>
  );
}
