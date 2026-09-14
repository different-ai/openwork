/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";

import { t } from "../../../i18n";
import {
  buildDenAuthUrl,
  clearDenSession,
  DEFAULT_DEN_BASE_URL,
  denOriginComparisonKey,
  normalizeDenBaseUrl,
  readDenBootstrapConfig,
  readDenSettings,
  resolveDenBaseUrls,
} from "../../../app/lib/den";
import { markDesktopSignInInitiated } from "../../../app/lib/den-sign-in-intent";
import { exchangeHandoffAndSignIn } from "../../../app/lib/den-handoff";
import { parseManualAuthInput } from "../../../app/lib/manual-auth-input";
import { normalizeOrganizationServerInput } from "../../../app/lib/organization-server-input";
import {
  denSessionUpdatedEvent,
  type DenSessionUpdatedDetail,
} from "../../../app/lib/den-session-events";
import { usePlatform } from "../../kernel/platform";
import { useBootState } from "../../shell/boot-state";
import { useDenAuth } from "./den-auth-provider";
import { useDesktopConfig } from "./desktop-config-provider";
import { applyBrandAppName, readDesktopDistributionInfo } from "../../../app/lib/desktop";
import { DenSignInSurface } from "./den-signin-surface";
import { tryOpenBrowserAuthUrl } from "./open-browser-auth";
import { saveControlPlaneUrl } from "../settings/cloud/control-plane-url";

export type ForcedSigninPageProps = {
  developerMode: boolean;
};

/**
 * React port of the Solid `ForcedSigninPage`
 * (`apps/app/src/app/cloud/forced-signin-page.tsx` on dev).
 *
 * Full-screen sign-in gate rendered when the desktop bootstrap config has
 * `requireSignin: true` and the user is not yet signed in. Owns the local
 * draft state (base URL, manual auth input) and pipes it into the
 * shared `DenSignInSurface` presentation layer.
 */
export function ForcedSigninPage({ developerMode }: ForcedSigninPageProps) {
  const platform = usePlatform();
  const denAuth = useDenAuth();
  const desktopConfig = useDesktopConfig();
  const { markRouteReady } = useBootState();

  const initial = readDenSettings();
  const bootstrap = readDenBootstrapConfig();
  const appName = bootstrap.brandAppName?.trim() || "OpenWork";
  const initialBaseUrl =
    bootstrap.enterpriseActivation?.denBaseUrl ||
    initial.baseUrl ||
    DEFAULT_DEN_BASE_URL;

  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [baseUrlDraft, setBaseUrlDraft] = useState(initialBaseUrl);
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [baseUrlBusy, setBaseUrlBusy] = useState(false);
  const [manualAuthOpen, setManualAuthOpen] = useState(false);
  const [manualAuthInput, setManualAuthInput] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [signinFallbackUrl, setSigninFallbackUrl] = useState<string | null>(null);

  useEffect(() => {
    document.title = appName;
    void applyBrandAppName(appName).catch(() => null);
  }, [appName]);

  const openControlPlane = useCallback(() => {
    platform.openLink(resolveDenBaseUrls(baseUrl).baseUrl);
  }, [baseUrl, platform]);

  const openBrowserAuth = useCallback(
    (mode: "sign-in" | "sign-up") => {
      const url = buildDenAuthUrl(baseUrl, mode);
      markDesktopSignInInitiated();
      setSigninFallbackUrl(url);
      setStatusMessage(
        mode === "sign-up"
          ? t("den.status_browser_signup")
          : t("den.status_browser_signin"),
      );
      setAuthError(null);
      void tryOpenBrowserAuthUrl(url).then((opened) => {
        if (opened) return;
        setStatusMessage(null);
        setManualAuthOpen(true);
      });
    },
    [baseUrl],
  );

  const exchangeGrant = useCallback(async (grant: string, nextBaseUrl: string) => {
    setAuthBusy(true);
    setAuthError(null);
    setStatusMessage(t("den.signing_in"));

    try {
      // The helper exchanges, commits, and dispatches the success/error session
      // events. An enterprise activation stamp lands in the same durable
      // commit as the enrollment it locks in.
      const result = await exchangeHandoffAndSignIn(grant, {
        baseUrl: nextBaseUrl,
        // Pasted one-time codes are desktop-initiated sign-ins.
        desktopInitiated: true,
        fallbackErrorMessage: t("den.error_no_token"),
        ...(readDesktopDistributionInfo().flavor === "enterprise"
          ? {
              bootstrap: {
                requireSignin: true,
                enterpriseActivation: {
                  activatedAt: new Date().toISOString(),
                  denBaseUrl: nextBaseUrl,
                },
              },
            }
          : {}),
      });
      if (!result.ok) {
        return false;
      }

      if (developerMode) {
        setBaseUrl(nextBaseUrl);
        setBaseUrlDraft(nextBaseUrl);
      }

      setSigninFallbackUrl(null);
      setManualAuthInput("");
      setManualAuthOpen(false);
      return true;
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : t("den.error_signin_failed"),
      );
      return false;
    } finally {
      setAuthBusy(false);
    }
  }, [developerMode]);

  const submitManualAuth = useCallback(async () => {
    const parsed = parseManualAuthInput(manualAuthInput);
    if (!parsed || authBusy) {
      if (!parsed) {
        setAuthError(t("den.error_paste_valid_code"));
      }
      return;
    }

    if (parsed.baseUrl && denOriginComparisonKey(parsed.baseUrl) !== denOriginComparisonKey(baseUrl)) {
      let pastedOrigin = parsed.baseUrl;
      try {
        pastedOrigin = new URL(parsed.baseUrl).origin;
      } catch {
        // Keep the parsed URL as the safe display fallback.
      }
      // Warden LZL-USH: switching servers must use the explicit workspace-address control, never a pasted link.
      setBaseUrlDraft(parsed.baseUrl);
      setAuthError(t("den.error_signin_link_other_server", { origin: pastedOrigin }));
      return;
    }

    const nextBaseUrl = parsed.baseUrl ?? baseUrl;
    return exchangeGrant(parsed.grant, nextBaseUrl);
  }, [authBusy, baseUrl, exchangeGrant, manualAuthInput]);

  useEffect(() => {
    if (typeof window === "undefined" || authBusy) return;

    const url = new URL(window.location.href);
    const grant = url.searchParams.get("grant")?.trim() ?? "";
    if (!grant) return;

    url.searchParams.delete("grant");
    window.history.replaceState(
      window.history.state,
      document.title,
      `${url.pathname}${url.search}${url.hash}`,
    );

    void exchangeGrant(grant, baseUrl);
  }, [authBusy, baseUrl, exchangeGrant]);

  const applyBaseUrl = useCallback(async (value?: string) => {
    const serverOrigin = normalizeOrganizationServerInput(value ?? baseUrlDraft);
    const normalized = serverOrigin ? normalizeDenBaseUrl(serverOrigin) : null;
    if (!normalized) {
      setBaseUrlError(t("den.error_base_url"));
      return false;
    }

    const resolved = resolveDenBaseUrls(normalized);
    setBaseUrlBusy(true);

    try {
      const persisted = await saveControlPlaneUrl(resolved.baseUrl);
      if (!persisted) {
        setBaseUrlError(t("den.error_base_url"));
        return false;
      }

      setBaseUrlError(null);
      setBaseUrl(persisted.baseUrl);
      setBaseUrlDraft(persisted.baseUrl);
      clearDenSession({ includeBaseUrls: false });
      setAuthError(null);
      setStatusMessage(t("den.status_base_url_updated"));
      void desktopConfig.refresh();
      void denAuth.refresh();
      return true;
    } catch (error) {
      setBaseUrlError(
        error instanceof Error
          ? error.message
          : t("den.error_base_url"),
      );
      return false;
    } finally {
      setBaseUrlBusy(false);
    }
  }, [baseUrlDraft, denAuth, desktopConfig]);

  // Listen for Den session events broadcast from the Tauri deep-link handler,
  // a successful browser auth, or an org switch, and reflect the result in
  // the sign-in surface's status/error banners.
  useEffect(() => {
    markRouteReady();
  }, [markRouteReady]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<DenSessionUpdatedDetail>;
      const nextSettings = readDenSettings();
      const nextBaseUrl =
        customEvent.detail?.baseUrl?.trim() ||
        nextSettings.baseUrl ||
        DEFAULT_DEN_BASE_URL;
      setBaseUrl(nextBaseUrl);
      setBaseUrlDraft(nextBaseUrl);

      if (customEvent.detail?.status === "success") {
        setAuthError(null);
        setSigninFallbackUrl(null);
        const email = customEvent.detail.email?.trim();
        setStatusMessage(
          email
            ? t("den.status_cloud_signed_in_as", { email })
            : t("den.status_cloud_signin_done"),
        );
      } else if (customEvent.detail?.status === "error") {
        setAuthError(
          customEvent.detail.message?.trim() || t("den.error_signin_failed"),
        );
      }
    };

    window.addEventListener(denSessionUpdatedEvent, handler as EventListener);
    return () => {
      window.removeEventListener(
        denSessionUpdatedEvent,
        handler as EventListener,
      );
    };
  }, []);

  // The forced sign-in gate is configured by the enterprise installer.
  // Do not expose the organization server editor on this managed surface.
  return (
    <DenSignInSurface
      variant="fullscreen"
      appName={appName}
      logoUrl={bootstrap.brandLogoUrl ?? null}
      developerMode={developerMode}
      baseUrl={baseUrl}
      baseUrlDraft={baseUrlDraft}
      baseUrlError={baseUrlError}
      statusMessage={statusMessage}
      signinFallbackUrl={signinFallbackUrl}
      authError={authError ?? denAuth.error}
      authBusy={authBusy}
      baseUrlBusy={baseUrlBusy}
      sessionBusy={denAuth.status === "checking"}
      manualAuthOpen={manualAuthOpen}
      manualAuthInput={manualAuthInput}
      onBaseUrlDraftInput={setBaseUrlDraft}
      onResetBaseUrl={() => setBaseUrlDraft(baseUrl)}
      onApplyBaseUrl={() => {
        void applyBaseUrl();
      }}
      onOpenControlPlane={openControlPlane}
      onOpenBrowserAuth={openBrowserAuth}
      onToggleManualAuth={() => {
        setManualAuthOpen((value) => !value);
        setAuthError(null);
      }}
      onManualAuthInput={setManualAuthInput}
      onSubmitManualAuth={() => {
        void submitManualAuth();
      }}
    />
  );
}
