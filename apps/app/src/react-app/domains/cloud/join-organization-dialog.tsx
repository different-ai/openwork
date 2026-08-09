/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";
import { installConfigSchema, parseInstallLinkInput } from "@openwork/install-config";

import { createDenClient, readDenBootstrapConfig, readDenSettings, setDenBootstrapConfig } from "@/app/lib/den";
import { exchangeHandoffAndSignIn } from "@/app/lib/den-handoff";
import { denSessionUpdatedEvent } from "@/app/lib/den-session-events";
import { desktopFetchViaMain } from "@/app/lib/desktop";
import { buildOrgInviteJoinUrl, parseOrgInviteLink } from "@/app/lib/openwork-links";
import { isDesktopRuntime } from "@/app/utils";
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
import { usePlatform } from "../../kernel/platform";
import { parseManualAuthInput } from "./forced-signin-page";

type JoinOrganizationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
};

type ConnectionStatus =
  | { phase: "idle" }
  | { phase: "connecting"; clientName: string; host: string }
  | { phase: "browser"; clientName: string; host: string }
  | { phase: "success"; clientName: string; host: string };

function hostFromUrl(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
}

type InvitePreview = {
  status: string;
  organizationName: string;
};

/**
 * Narrow the public `/v1/orgs/invitations/preview` payload to the two fields
 * this dialog needs. The endpoint is unauthenticated by design, so treat the
 * body as untrusted input rather than assuming the full server shape.
 */
function parseInvitePreview(payload: unknown): InvitePreview | null {
  if (typeof payload !== "object" || payload === null) return null;
  const invitation = Reflect.get(payload, "invitation");
  const organization = Reflect.get(payload, "organization");
  if (typeof invitation !== "object" || invitation === null) return null;
  if (typeof organization !== "object" || organization === null) return null;
  const status = Reflect.get(invitation, "status");
  const organizationName = Reflect.get(organization, "name");
  if (typeof status !== "string" || typeof organizationName !== "string" || !organizationName.trim()) {
    return null;
  }
  return { status, organizationName: organizationName.trim() };
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
  const trimmedInput = input.trim();
  const statusMessage = useMemo(() => {
    if (status.phase === "connecting") {
      return t("join_org.connecting", {
        clientName: status.clientName,
        host: status.host,
      });
    }
    if (status.phase === "browser") {
      return t("join_org.invite_browser_wait", {
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
    const link = parseOrgInviteLink(value);
    if (!link) return false;

    let response: Response;
    try {
      response = await fetchInstallConfig(link.previewUrl);
    } catch {
      setError(t("join_org.error_network"));
      return true;
    }

    if (response.status === 404) {
      setError(t("join_org.error_invite_not_found"));
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
    const preview = parseInvitePreview(payload);
    if (!preview) {
      setError(t("join_org.error_invalid_config"));
      return true;
    }
    if (preview.status === "canceled" || preview.status === "expired") {
      setError(t("join_org.error_invite_unusable"));
      return true;
    }

    // Membership is accepted in the browser, where the person can review the
    // invite and authenticate; the web flow then hands a one-time grant back
    // to this app (`openwork://den-auth?…`), which signs it in. Pending and
    // already-accepted invites both continue there — the join page resolves
    // each state correctly.
    setStatus({ phase: "browser", clientName: preview.organizationName, host: link.host });
    platform.openLink(buildOrgInviteJoinUrl(link, { desktopAuth: isDesktopRuntime() }));
    return true;
  }, [platform]);

  // While the invite finishes in the browser, the deep link comes back to the
  // whole app (den-auth provider), not this dialog — so observe the shared
  // session event to learn the sign-in landed.
  useEffect(() => {
    if (status.phase !== "browser") return;
    const handler = (event: WindowEventMap[typeof denSessionUpdatedEvent]) => {
      if (event.detail?.status !== "success") return;
      setStatus({ phase: "success", clientName: status.clientName, host: status.host });
      finishConnected();
    };
    window.addEventListener(denSessionUpdatedEvent, handler);
    return () => window.removeEventListener(denSessionUpdatedEvent, handler);
  }, [finishConnected, status]);

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
      if (await submitInviteLink(trimmedInput)) return;
      if (await submitManualAuth(trimmedInput)) return;
      setError(t("join_org.error_invalid"));
    } finally {
      setBusy(false);
    }
  }, [busy, reset, submitInstallLink, submitInviteLink, submitManualAuth, trimmedInput]);

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
                // Editing the input abandons a "finish in the browser" wait so
                // the person can submit a different link.
                setStatus((current) => (current.phase === "browser" ? { phase: "idle" } : current));
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
          <Button type="button" onClick={submit} disabled={busy || !trimmedInput || status.phase === "browser"}>
            {busy
              ? t("join_org.connecting_button")
              : status.phase === "browser"
                ? t("join_org.waiting_browser_button")
                : t("join_org.connect_button")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
