/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";

import { currentLocale, t } from "../../../i18n";
import {
  buildDenAuthUrl,
  clearDenSession,
  createDenClient,
  DEFAULT_DEN_BASE_URL,
  normalizeDenBaseUrl,
  readDenBootstrapConfig,
  readDenSettings,
  resolveDenBaseUrls,
  setDenBootstrapConfig,
  writeDenSettings,
} from "../../../app/lib/den";
import {
  denSessionUpdatedEvent,
  dispatchDenSessionUpdated,
  type DenSessionUpdatedDetail,
} from "../../../app/lib/den-session-events";
import { usePlatform } from "../../kernel/platform";
import { useDenAuth } from "./den-auth-provider";
import { useDesktopConfig } from "./desktop-config-provider";
import { DenSignInSurface } from "./den-signin-surface";

export type ForcedSigninPageProps = {
  developerMode: boolean;
};

/**
 * Parse a pasted manual-auth input. Accepts either a raw handoff grant
 * string (>= 12 chars) or an `openwork://den-auth?grant=…` deep link.
 * Matches the Solid ForcedSigninPage exactly so flows stay fungible.
 */
function parseManualAuthInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    const protocol = url.protocol.toLowerCase();
    const routeHost = url.hostname.toLowerCase();
    const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
    const routeSegments = routePath.split("/").filter(Boolean);
    const routeTail = routeSegments[routeSegments.length - 1] ?? "";
    if (
      (protocol === "openwork:" || protocol === "openwork-dev:") &&
      (routeHost === "den-auth" ||
        routePath === "den-auth" ||
        routeTail === "den-auth")
    ) {
      const grant = url.searchParams.get("grant")?.trim() ?? "";
      const nextBaseUrl =
        normalizeDenBaseUrl(url.searchParams.get("denBaseUrl")?.trim() ?? "") ??
        undefined;
      return grant ? { grant, baseUrl: nextBaseUrl } : null;
    }
  } catch {
    // Treat non-URL input as a raw handoff grant.
  }

  return trimmed.length >= 12 ? { grant: trimmed } : null;
}

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
  const tr = useCallback((key: string) => t(key, currentLocale()), []);

  const initial = readDenSettings();
  const initialBaseUrl = initial.baseUrl || DEFAULT_DEN_BASE_URL;

  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [baseUrlDraft, setBaseUrlDraft] = useState(initialBaseUrl);
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [baseUrlBusy, setBaseUrlBusy] = useState(false);
  const [manualAuthOpen, setManualAuthOpen] = useState(false);
  const [manualAuthInput, setManualAuthInput] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const openControlPlane = useCallback(() => {
    platform.openLink(resolveDenBaseUrls(baseUrl).baseUrl);
  }, [baseUrl, platform]);

  const openBrowserAuth = useCallback(
    (mode: "sign-in" | "sign-up") => {
      platform.openLink(buildDenAuthUrl(baseUrl, mode));
      setStatusMessage(
        mode === "sign-up"
          ? tr("den.status_browser_signup")
          : tr("den.status_browser_signin"),
      );
      setAuthError(null);
    },
    [baseUrl, platform, tr],
  );

  const submitManualAuth = useCallback(async () => {
    const parsed = parseManualAuthInput(manualAuthInput);
    if (!parsed || authBusy) {
      if (!parsed) {
        setAuthError(tr("den.error_paste_valid_code"));
      }
      return;
    }

    const nextBaseUrl = parsed.baseUrl ?? baseUrl;

    setAuthBusy(true);
    setAuthError(null);
    setStatusMessage(tr("den.signing_in"));

    try {
      const result = await createDenClient({
        baseUrl: nextBaseUrl,
      }).exchangeDesktopHandoff(parsed.grant);
      if (!result.token) {
        throw new Error(tr("den.error_no_token"));
      }

      if (developerMode) {
        setBaseUrl(nextBaseUrl);
        setBaseUrlDraft(nextBaseUrl);
      }

      writeDenSettings({
        baseUrl: nextBaseUrl,
        authToken: result.token,
        activeOrgId: null,
        activeOrgSlug: null,
        activeOrgName: null,
      });

      setManualAuthInput("");
      setManualAuthOpen(false);
      dispatchDenSessionUpdated({
        status: "success",
        baseUrl: nextBaseUrl,
        token: result.token,
        user: result.user,
        email: result.user?.email ?? null,
      });
    } catch (error) {
      dispatchDenSessionUpdated({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : tr("den.error_signin_failed"),
      });
    } finally {
      setAuthBusy(false);
    }
  }, [authBusy, baseUrl, developerMode, manualAuthInput, tr]);

  const applyBaseUrl = useCallback(async () => {
    const normalized = normalizeDenBaseUrl(baseUrlDraft);
    if (!normalized) {
      setBaseUrlError(tr("den.error_base_url"));
      return;
    }

    const resolved = resolveDenBaseUrls(normalized);
    setBaseUrlBusy(true);

    try {
      await setDenBootstrapConfig({
        baseUrl: resolved.baseUrl,
        apiBaseUrl: resolved.apiBaseUrl,
        requireSignin: readDenBootstrapConfig().requireSignin,
      });
      setBaseUrlError(null);
      setBaseUrl(resolved.baseUrl);
      setBaseUrlDraft(resolved.baseUrl);
      clearDenSession({ includeBaseUrls: !developerMode });
      writeDenSettings(
        {
          baseUrl: resolved.baseUrl,
          apiBaseUrl: resolved.apiBaseUrl,
          authToken: null,
          activeOrgId: null,
          activeOrgSlug: null,
          activeOrgName: null,
        },
        { persistBootstrap: false },
      );
      setAuthError(null);
      setStatusMessage(tr("den.status_base_url_updated"));
      void desktopConfig.refresh();
      void denAuth.refresh();
    } catch (error) {
      setBaseUrlError(
        error instanceof Error
          ? error.message
          : tr("den.error_base_url"),
      );
    } finally {
      setBaseUrlBusy(false);
    }
  }, [baseUrlDraft, denAuth, desktopConfig, developerMode, tr]);

  // Listen for Den session events broadcast from the Tauri deep-link handler,
  // a successful browser auth, or an org switch, and reflect the result in
  // the sign-in surface's status/error banners.
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
        const email = customEvent.detail.email?.trim();
        setStatusMessage(
          email
            ? t("den.status_cloud_signed_in_as", currentLocale(), { email })
            : tr("den.status_cloud_signin_done"),
        );
      } else if (customEvent.detail?.status === "error") {
        setAuthError(
          customEvent.detail.message?.trim() || tr("den.error_signin_failed"),
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
  }, [tr]);

  return (
    <DenSignInSurface
      variant="fullscreen"
      developerMode={developerMode}
      baseUrl={baseUrl}
      baseUrlDraft={baseUrlDraft}
      baseUrlError={baseUrlError}
      statusMessage={statusMessage}
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
