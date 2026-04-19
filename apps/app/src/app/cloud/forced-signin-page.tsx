import { createSignal, onCleanup, onMount } from "solid-js";
import DenSignInSurface from "./den-signin-surface";
import { useDenAuth } from "./den-auth-provider";
import { useDesktopConfig } from "./desktop-config-provider";
import { usePlatform } from "../context/platform";
import { currentLocale, t } from "../../i18n";
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
} from "../lib/den";
import { denSessionUpdatedEvent, dispatchDenSessionUpdated, type DenSessionUpdatedDetail } from "../lib/den-session-events";

type ForcedSigninPageProps = {
  developerMode: boolean;
};

export default function ForcedSigninPage(props: ForcedSigninPageProps) {
  const platform = usePlatform();
  const denAuth = useDenAuth();
  const desktopConfig = useDesktopConfig();
  const initial = readDenSettings();
  const initialBaseUrl = initial.baseUrl || DEFAULT_DEN_BASE_URL;

  const [baseUrl, setBaseUrl] = createSignal(initialBaseUrl);
  const [baseUrlDraft, setBaseUrlDraft] = createSignal(initialBaseUrl);
  const [baseUrlError, setBaseUrlError] = createSignal<string | null>(null);
  const [authBusy, setAuthBusy] = createSignal(false);
  const [baseUrlBusy, setBaseUrlBusy] = createSignal(false);
  const [manualAuthOpen, setManualAuthOpen] = createSignal(false);
  const [manualAuthInput, setManualAuthInput] = createSignal("");
  const [authError, setAuthError] = createSignal<string | null>(null);
  const [statusMessage, setStatusMessage] = createSignal<string | null>(null);

  const openControlPlane = () => {
    platform.openLink(resolveDenBaseUrls(baseUrl()).baseUrl);
  };

  const openBrowserAuth = (mode: "sign-in" | "sign-up") => {
    platform.openLink(buildDenAuthUrl(baseUrl(), mode));
    setStatusMessage(
      mode === "sign-up"
        ? t("den.status_browser_signup", currentLocale())
        : t("den.status_browser_signin", currentLocale()),
    );
    setAuthError(null);
  };

  const parseManualAuthInput = (value: string) => {
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
        (routeHost === "den-auth" || routePath === "den-auth" || routeTail === "den-auth")
      ) {
        const grant = url.searchParams.get("grant")?.trim() ?? "";
        const nextBaseUrl =
          normalizeDenBaseUrl(url.searchParams.get("denBaseUrl")?.trim() ?? "") ?? undefined;
        return grant ? { grant, baseUrl: nextBaseUrl } : null;
      }
    } catch {
      // treat non-URL input as a raw handoff grant
    }

    return trimmed.length >= 12 ? { grant: trimmed } : null;
  };

  const submitManualAuth = async () => {
    const parsed = parseManualAuthInput(manualAuthInput());
    if (!parsed || authBusy()) {
      if (!parsed) {
        setAuthError(t("den.error_paste_valid_code", currentLocale()));
      }
      return;
    }

    const nextBaseUrl = parsed.baseUrl ?? baseUrl();

    setAuthBusy(true);
    setAuthError(null);
    setStatusMessage(t("den.signing_in", currentLocale()));

    try {
      const result = await createDenClient({ baseUrl: nextBaseUrl }).exchangeDesktopHandoff(parsed.grant);
      if (!result.token) {
        throw new Error(t("den.error_no_token", currentLocale()));
      }

      if (props.developerMode) {
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
        message: error instanceof Error ? error.message : t("den.error_signin_failed", currentLocale()),
      });
    } finally {
      setAuthBusy(false);
    }
  };

  const applyBaseUrl = async () => {
    const normalized = normalizeDenBaseUrl(baseUrlDraft());
    if (!normalized) {
      setBaseUrlError(t("den.error_base_url", currentLocale()));
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
      clearDenSession({ includeBaseUrls: !props.developerMode });
      writeDenSettings({
        baseUrl: resolved.baseUrl,
        apiBaseUrl: resolved.apiBaseUrl,
        authToken: null,
        activeOrgId: null,
        activeOrgSlug: null,
        activeOrgName: null,
      }, { persistBootstrap: false });
      setAuthError(null);
      setStatusMessage(t("den.status_base_url_updated", currentLocale()));
      void desktopConfig.refresh();
      void denAuth.refresh();
    } catch (error) {
      setBaseUrlError(
        error instanceof Error ? error.message : t("den.error_base_url", currentLocale()),
      );
    } finally {
      setBaseUrlBusy(false);
    }
  };

  onMount(() => {
    if (typeof window === "undefined") {
      return;
    }

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
        setStatusMessage(
          customEvent.detail.email?.trim()
            ? t("den.status_cloud_signed_in_as", currentLocale(), { email: customEvent.detail.email.trim() })
            : t("den.status_cloud_signin_done", currentLocale()),
        );
      } else if (customEvent.detail?.status === "error") {
        setAuthError(
          customEvent.detail.message?.trim() ||
            t("den.error_signin_failed", currentLocale()),
        );
      }
    };

    window.addEventListener(denSessionUpdatedEvent, handler as EventListener);
    onCleanup(() => {
      window.removeEventListener(denSessionUpdatedEvent, handler as EventListener);
    });
  });

  return (
    <DenSignInSurface
      variant="fullscreen"
      developerMode={props.developerMode}
      baseUrl={baseUrl()}
      baseUrlDraft={baseUrlDraft()}
      baseUrlError={baseUrlError()}
      statusMessage={statusMessage()}
      authError={authError() ?? denAuth.error()}
      authBusy={authBusy()}
      baseUrlBusy={baseUrlBusy()}
      sessionBusy={denAuth.status() === "checking"}
      manualAuthOpen={manualAuthOpen()}
      manualAuthInput={manualAuthInput()}
      onBaseUrlDraftInput={setBaseUrlDraft}
      onResetBaseUrl={() => setBaseUrlDraft(baseUrl())}
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
