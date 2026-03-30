import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { ArrowUpRight, Boxes, Cloud, LogOut, RefreshCcw, Server, Users } from "lucide-solid";

import Button from "./button";
import TextInput from "./text-input";
import {
  buildDenAuthUrl,
  clearDenSession,
  DEFAULT_DEN_BASE_URL,
  DenApiError,
  type DenTemplate,
  createDenClient,
  normalizeDenBaseUrl,
  readDenSettings,
  resolveDenBaseUrls,
  writeDenSettings,
} from "../lib/den";
import {
  clearDenTemplateCache,
  loadDenTemplateCache,
  readDenTemplateCacheSnapshot,
} from "../lib/den-template-cache";
import { usePlatform } from "../context/platform";

type DenSettingsPanelProps = {
  developerMode: boolean;
  connectRemoteWorkspace: (input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => Promise<boolean>;
  openTeamBundle: (input: {
    templateId: string;
    name: string;
    templateData: unknown;
    organizationName?: string | null;
  }) => void | Promise<void>;
};

function statusBadgeClass(kind: "ready" | "warning" | "neutral" | "error") {
  switch (kind) {
    case "ready":
      return "border-green-7/30 bg-green-3/20 text-green-11";
    case "warning":
      return "border-amber-7/30 bg-amber-3/20 text-amber-11";
    case "error":
      return "border-red-7/30 bg-red-3/20 text-red-11";
    default:
      return "border-gray-6/60 bg-gray-3/20 text-gray-11";
  }
}

function workerStatusMeta(status: string) {
  const normalized = status.trim().toLowerCase();
  switch (normalized) {
    case "healthy":
      return { label: "Ready", tone: "ready" as const, canOpen: true };
    case "provisioning":
      return { label: "Provisioning", tone: "warning" as const, canOpen: false };
    case "failed":
      return { label: "Failed", tone: "error" as const, canOpen: false };
    case "stopped":
      return { label: "Stopped", tone: "neutral" as const, canOpen: false };
    default:
      return {
        label: normalized
          ? `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`
          : "Unknown",
        tone: "neutral" as const,
        canOpen: normalized === "ready",
      };
  }
}

export default function DenSettingsPanel(props: DenSettingsPanelProps) {
  const platform = usePlatform();
  const initial = readDenSettings();
  const initialBaseUrl = props.developerMode
    ? initial.baseUrl || DEFAULT_DEN_BASE_URL
    : DEFAULT_DEN_BASE_URL;

  const [baseUrl, setBaseUrl] = createSignal(initialBaseUrl);
  const [baseUrlDraft, setBaseUrlDraft] = createSignal(initialBaseUrl);
  const [baseUrlError, setBaseUrlError] = createSignal<string | null>(null);
  const [authToken, setAuthToken] = createSignal(initial.authToken?.trim() || "");
  const [activeOrgId, setActiveOrgId] = createSignal(initial.activeOrgId?.trim() || "");
  const [authBusy, setAuthBusy] = createSignal(false);
  const [manualAuthOpen, setManualAuthOpen] = createSignal(false);
  const [manualAuthInput, setManualAuthInput] = createSignal("");
  const [sessionBusy, setSessionBusy] = createSignal(false);
  const [orgsBusy, setOrgsBusy] = createSignal(false);
  const [workersBusy, setWorkersBusy] = createSignal(false);
  const [openingWorkerId, setOpeningWorkerId] = createSignal<string | null>(null);
  const [openingTemplateId, setOpeningTemplateId] = createSignal<string | null>(null);
  const [user, setUser] = createSignal<{
    id: string;
    email: string;
    name: string | null;
  } | null>(null);
  const [orgs, setOrgs] = createSignal<
    Array<{ id: string; name: string; slug: string; role: "owner" | "member" }>
  >([]);
  const [workers, setWorkers] = createSignal<
    Array<{
      workerId: string;
      workerName: string;
      status: string;
      instanceUrl: string | null;
      provider: string | null;
      isMine: boolean;
      createdAt: string | null;
    }>
  >([]);
  const [statusMessage, setStatusMessage] = createSignal<string | null>(null);
  const [authError, setAuthError] = createSignal<string | null>(null);
  const [orgsError, setOrgsError] = createSignal<string | null>(null);
  const [workersError, setWorkersError] = createSignal<string | null>(null);
  const [templateActionError, setTemplateActionError] = createSignal<string | null>(null);

  const activeOrg = createMemo(() => orgs().find((org) => org.id === activeOrgId()) ?? null);
  const client = createMemo(() =>
    createDenClient({ baseUrl: baseUrl(), token: authToken() }),
  );
  const isSignedIn = createMemo(() => Boolean(user() && authToken().trim()));
  const activeOrgName = createMemo(() => activeOrg()?.name || "No org selected");
  const templateCacheSnapshot = createMemo(() =>
    readDenTemplateCacheSnapshot({
      baseUrl: baseUrl(),
      token: authToken(),
      orgSlug: activeOrg()?.slug ?? null,
    }),
  );
  const templatesBusy = createMemo(() => templateCacheSnapshot().busy);
  const templates = createMemo(() => templateCacheSnapshot().templates);
  const templatesError = createMemo(
    () => templateActionError() ?? templateCacheSnapshot().error,
  );

  const summaryTone = createMemo(() => {
    if (authError() || workersError() || orgsError() || templatesError()) return "error" as const;
    if (sessionBusy() || orgsBusy() || workersBusy() || templatesBusy()) return "warning" as const;
    if (isSignedIn()) return "ready" as const;
    return "neutral" as const;
  });

  const summaryLabel = createMemo(() => {
    if (authError()) return "Needs attention";
    if (sessionBusy()) return "Checking session";
    if (isSignedIn()) return "Connected";
    return "Signed out";
  });

  createEffect(() => {
    writeDenSettings({
      baseUrl: props.developerMode ? baseUrl() : DEFAULT_DEN_BASE_URL,
      authToken: authToken() || null,
      activeOrgId: activeOrgId() || null,
      activeOrgSlug: activeOrg()?.slug ?? null,
      activeOrgName: activeOrg()?.name ?? null,
    });
  });

  createEffect(() => {
    if (!props.developerMode) {
      setBaseUrl(DEFAULT_DEN_BASE_URL);
      setBaseUrlDraft(DEFAULT_DEN_BASE_URL);
      setBaseUrlError(null);
    }
  });

  const openControlPlane = () => {
    platform.openLink(resolveDenBaseUrls(baseUrl()).baseUrl);
  };

  const openBrowserAuth = (mode: "sign-in" | "sign-up") => {
    platform.openLink(buildDenAuthUrl(baseUrl(), mode));
    setStatusMessage(
      mode === "sign-up"
        ? "Finish account creation in your browser to connect OpenWork."
        : "Finish signing in in your browser to connect OpenWork.",
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
        setAuthError("Paste a valid OpenWork sign-in link or one-time sign-in code.");
      }
      return;
    }

    const nextBaseUrl = parsed.baseUrl ?? baseUrl();

    setAuthBusy(true);
    setAuthError(null);
    setStatusMessage("Finishing OpenWork Cloud sign-in...");

    try {
      const result = await createDenClient({ baseUrl: nextBaseUrl }).exchangeDesktopHandoff(parsed.grant);
      if (!result.token) {
        throw new Error("Desktop sign-in completed, but OpenWork Cloud did not return a session token.");
      }

      if (props.developerMode) {
        setBaseUrl(nextBaseUrl);
        setBaseUrlDraft(nextBaseUrl);
      }

      writeDenSettings({
        baseUrl: props.developerMode ? nextBaseUrl : DEFAULT_DEN_BASE_URL,
        authToken: result.token,
        activeOrgId: null,
        activeOrgSlug: null,
        activeOrgName: null,
      });

      setManualAuthInput("");
      setManualAuthOpen(false);
      window.dispatchEvent(
        new CustomEvent("openwork-den-session-updated", {
          detail: {
            status: "success",
            email: result.user?.email ?? null,
          },
        }),
      );
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("openwork-den-session-updated", {
          detail: {
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Failed to complete OpenWork Cloud sign-in.",
          },
        }),
      );
    } finally {
      setAuthBusy(false);
    }
  };

  const clearSessionState = () => {
    setUser(null);
    setOrgs([]);
    setWorkers([]);
    setActiveOrgId("");
    setOrgsError(null);
    setWorkersError(null);
    setTemplateActionError(null);
  };

  const clearSignedInState = (message?: string | null) => {
    clearDenSession({ includeBaseUrls: !props.developerMode });
    clearDenTemplateCache();
    if (!props.developerMode) {
      setBaseUrl(DEFAULT_DEN_BASE_URL);
      setBaseUrlDraft(DEFAULT_DEN_BASE_URL);
    }
    setAuthToken("");
    setOpeningWorkerId(null);
    setOpeningTemplateId(null);
    clearSessionState();
    setBaseUrlError(null);
    setAuthError(null);
    setStatusMessage(message ?? null);
  };

  const applyBaseUrl = () => {
    const normalized = normalizeDenBaseUrl(baseUrlDraft());
    if (!normalized) {
      setBaseUrlError("Enter a valid http:// or https:// Cloud control plane URL.");
      return;
    }

    const resolved = resolveDenBaseUrls(normalized);
    setBaseUrlError(null);
    if (resolved.baseUrl === baseUrl()) {
      setBaseUrlDraft(resolved.baseUrl);
      return;
    }

    setBaseUrl(resolved.baseUrl);
    setBaseUrlDraft(resolved.baseUrl);
    clearSignedInState("Updated the Cloud control plane URL. Sign in again to continue.");
  };

  const refreshOrgs = async (quiet = false) => {
    if (!authToken().trim()) {
      setOrgs([]);
      setActiveOrgId("");
      return;
    }

    setOrgsBusy(true);
    if (!quiet) setOrgsError(null);

    try {
      const response = await client().listOrgs();
      setOrgs(response.orgs);
      const current = activeOrgId().trim();
      const fallback = response.defaultOrgId ?? response.orgs[0]?.id ?? "";
      const next = response.orgs.some((org) => org.id === current) ? current : fallback;
      const nextOrg = response.orgs.find((org) => org.id === next) ?? null;
      setActiveOrgId(next);
      writeDenSettings({
        baseUrl: props.developerMode ? baseUrl() : DEFAULT_DEN_BASE_URL,
        authToken: authToken() || null,
        activeOrgId: next || null,
        activeOrgSlug: nextOrg?.slug ?? null,
        activeOrgName: nextOrg?.name ?? null,
      });
      if (!quiet && response.orgs.length > 0) {
        setStatusMessage(
          `Loaded ${response.orgs.length} org${response.orgs.length === 1 ? "" : "s"}.`,
        );
      }
    } catch (error) {
      setOrgsError(error instanceof Error ? error.message : "Failed to load orgs.");
    } finally {
      setOrgsBusy(false);
    }
  };

  const refreshWorkers = async (quiet = false) => {
    const orgId = activeOrgId().trim();
    if (!authToken().trim() || !orgId) {
      setWorkers([]);
      return;
    }

    setWorkersBusy(true);
    if (!quiet) setWorkersError(null);

    try {
      const nextWorkers = await client().listWorkers(orgId, 20);
      setWorkers(nextWorkers);
      if (!quiet) {
        setStatusMessage(
          nextWorkers.length > 0
            ? `Loaded ${nextWorkers.length} worker${nextWorkers.length === 1 ? "" : "s"} for ${activeOrg()?.name ?? "this org"}.`
            : `No workers found for ${activeOrg()?.name ?? "this org"}.`,
        );
      }
    } catch (error) {
      setWorkersError(error instanceof Error ? error.message : "Failed to load workers.");
    } finally {
      setWorkersBusy(false);
    }
  };

  const refreshTemplates = async (quiet = false) => {
    const orgSlug = activeOrg()?.slug?.trim() ?? "";
    if (!authToken().trim() || !orgSlug) {
      return;
    }

    setTemplateActionError(null);

    try {
      const nextTemplates = await loadDenTemplateCache(
        {
          baseUrl: baseUrl(),
          token: authToken(),
          orgSlug,
        },
        { force: true },
      );
      if (!quiet) {
        setStatusMessage(
          nextTemplates.length > 0
            ? `Loaded ${nextTemplates.length} template${nextTemplates.length === 1 ? "" : "s"} for ${activeOrg()?.name ?? "this org"}.`
            : `No team templates found for ${activeOrg()?.name ?? "this org"}.`,
        );
      }
    } catch (error) {
      if (!quiet) {
        setTemplateActionError(error instanceof Error ? error.message : "Failed to load team templates.");
      }
    }
  };

  createEffect(() => {
    const token = authToken().trim();
    const currentBaseUrl = baseUrl();
    let cancelled = false;

    if (!token) {
      setSessionBusy(false);
      clearSessionState();
      setAuthError(null);
      return;
    }

    setSessionBusy(true);
    setAuthError(null);

    void createDenClient({ baseUrl: currentBaseUrl, token })
      .getSession()
      .then((nextUser) => {
        if (cancelled) return;
        setUser(nextUser);
        setStatusMessage(`Signed in as ${nextUser.email}.`);
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof DenApiError && error.status === 401) {
          clearSignedInState();
        } else {
          clearSessionState();
        }
        setAuthError(
          error instanceof Error ? error.message : "No active Cloud session found.",
        );
      })
      .finally(() => {
        if (!cancelled) setSessionBusy(false);
      });

    return () => {
      cancelled = true;
    };
  });

  createEffect(() => {
    if (!user()) return;
    void refreshOrgs(true);
  });

  createEffect(() => {
    if (!user() || !activeOrgId().trim()) return;
    void refreshWorkers(true);
  });

  createEffect(() => {
    if (!user() || !activeOrg()?.slug?.trim()) return;
    void refreshTemplates(true);
  });

  createEffect(() => {
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<{
        status?: string;
        email?: string | null;
        message?: string | null;
      }>;
      const nextSettings = readDenSettings();
      setBaseUrl(nextSettings.baseUrl || DEFAULT_DEN_BASE_URL);
      setBaseUrlDraft(nextSettings.baseUrl || DEFAULT_DEN_BASE_URL);
      setAuthToken(nextSettings.authToken?.trim() || "");
      setActiveOrgId(nextSettings.activeOrgId?.trim() || "");
      if (customEvent.detail?.status === "success") {
        setAuthError(null);
        setStatusMessage(
          customEvent.detail.email?.trim()
            ? `Connected OpenWork Cloud as ${customEvent.detail.email.trim()}.`
            : "Connected OpenWork Cloud.",
        );
      } else if (customEvent.detail?.status === "error") {
        setAuthError(
          customEvent.detail.message?.trim() ||
            "Failed to finish OpenWork Cloud sign-in.",
        );
      }
    };

    window.addEventListener(
      "openwork-den-session-updated",
      handler as EventListener,
    );
    return () =>
      window.removeEventListener(
        "openwork-den-session-updated",
        handler as EventListener,
      );
  });

  const signOut = async () => {
    if (authBusy()) return;

    setAuthBusy(true);
    try {
      if (authToken().trim()) {
        await client().signOut();
      }
    } catch {
      // ignore remote sign out failures
    } finally {
      setAuthBusy(false);
    }

    clearSignedInState(
      "Signed out and cleared your OpenWork Cloud session on this device.",
    );
  };

  const handleOpenWorker = async (workerId: string, workerName: string) => {
    const orgId = activeOrgId().trim();
    if (!orgId) {
      setWorkersError("Choose an org before opening a worker.");
      return;
    }

    setOpeningWorkerId(workerId);
    setWorkersError(null);

    try {
      const tokens = await client().getWorkerTokens(workerId, orgId);
      const openworkUrl = tokens.openworkUrl?.trim() ?? "";
      const accessToken =
        tokens.ownerToken?.trim() || tokens.clientToken?.trim() || "";
      if (!openworkUrl || !accessToken) {
        throw new Error(
          "Worker is not ready to open yet. Try again after provisioning finishes.",
        );
      }

      const ok = await props.connectRemoteWorkspace({
        openworkHostUrl: openworkUrl,
        openworkToken: accessToken,
        directory: null,
        displayName: workerName,
      });
      if (!ok) {
        throw new Error(`Failed to open ${workerName} in OpenWork.`);
      }

      setStatusMessage(`Opened ${workerName} in OpenWork.`);
    } catch (error) {
      setWorkersError(
        error instanceof Error ? error.message : `Failed to open ${workerName}.`,
      );
    } finally {
      setOpeningWorkerId(null);
    }
  };

  const handleOpenTemplate = async (template: DenTemplate) => {
    if (openingTemplateId()) return;

    setOpeningTemplateId(template.id);
    setTemplateActionError(null);

    try {
      await props.openTeamBundle({
        templateId: template.id,
        name: template.name,
        templateData: template.templateData,
        organizationName: activeOrg()?.name ?? null,
      });
      setStatusMessage(`Opened ${template.name} from ${activeOrg()?.name ?? "team templates"}.`);
    } catch (error) {
      setTemplateActionError(error instanceof Error ? error.message : `Failed to open ${template.name}.`);
    } finally {
      setOpeningTemplateId(null);
    }
  };

  const formatTemplateTimestamp = (value: string | null) => {
    if (!value) return "Recently updated";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Recently updated";
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date);
  };

  const templateCreatorLabel = (template: DenTemplate) => {
    const creator = template.creator;
    if (!creator) return "Unknown creator";
    return creator.name?.trim() || creator.email?.trim() || "Unknown creator";
  };

  const settingsPanelClass =
    "ow-soft-card rounded-[28px] p-5 md:p-6";
  const settingsPanelSoftClass =
    "ow-soft-card-quiet rounded-2xl p-4";
  const headerBadgeClass =
    "inline-flex min-h-8 items-center gap-2 rounded-xl bg-[#f3f4f6] px-3 text-[13px] font-medium text-dls-text";
  const headerStatusBadgeClass =
    "inline-flex min-h-10 min-w-[132px] items-center justify-center gap-2 rounded-2xl bg-[#f3f4f6] px-4 text-center text-sm font-medium text-dls-text";
  const sectionPillClass =
    "inline-flex items-center gap-1.5 rounded-full bg-[#f3f4f6] px-2.5 py-1 text-[11px] font-medium text-gray-11";
  const softNoticeClass =
    "rounded-xl bg-[#f8fafc] px-3 py-2 text-xs text-gray-11";
  const quietControlClass =
    "bg-white/90 text-dls-text border border-black/8 shadow-[0_1px_2px_rgba(17,24,39,0.06)]";

  return (
    <div class="space-y-6">
      <div class={`${settingsPanelClass} space-y-4`}>
        <div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div class="space-y-2">
            <div class={headerBadgeClass}>
              <Cloud size={13} class="text-dls-secondary" />
              OpenWork Cloud
            </div>
            <div>
              <div class="text-sm font-medium text-dls-text">
                Sign in, pick an org, and open Cloud workers or team templates.
              </div>
              <div class="mt-1 max-w-[60ch] text-xs text-dls-secondary">
                Sign in to OpenWork Cloud to keep your tasks alive even when your
                computer sleeps.
              </div>
            </div>
          </div>
          <div class={headerStatusBadgeClass}>
            <span
              class={`h-2 w-2 rounded-full ${summaryTone() === "ready" ? "bg-green-500" : summaryTone() === "warning" ? "bg-amber-500" : summaryTone() === "error" ? "bg-red-500" : "bg-gray-400"}`}
            />
            {summaryLabel()}
          </div>
        </div>

        <Show when={props.developerMode}>
          <div class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <TextInput
              label="Cloud control plane URL"
              value={baseUrlDraft()}
              onInput={(event) => setBaseUrlDraft(event.currentTarget.value)}
              placeholder={DEFAULT_DEN_BASE_URL}
              hint="Developer mode only. Use this to target a local or self-hosted Cloud control plane. Changing it signs you out so the app can re-hydrate against the new control plane."
              disabled={authBusy() || sessionBusy()}
            />
            <div class="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                class="h-9 px-3 text-xs"
                onClick={() => setBaseUrlDraft(baseUrl())}
                disabled={authBusy() || sessionBusy()}
              >
                Reset
              </Button>
              <Button
                variant="secondary"
                class="h-9 px-3 text-xs"
                onClick={applyBaseUrl}
                disabled={authBusy() || sessionBusy()}
              >
                Save URL
              </Button>
              <Button
                variant="outline"
                class="h-9 px-3 text-xs"
                onClick={openControlPlane}
              >
                Open in browser
                <ArrowUpRight size={13} />
              </Button>
            </div>
          </div>
        </Show>

        <Show when={baseUrlError()}>
          {(value) => (
            <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
              {value()}
            </div>
          )}
        </Show>

        <Show when={statusMessage() && !authError() && !workersError() && !orgsError() && !templatesError()}>
          {(value) => (
            <div class={softNoticeClass}>
              {value()}
            </div>
          )}
        </Show>
      </div>

      <Show when={!isSignedIn()}>
        <div class={`${settingsPanelClass} space-y-4`}>
            <div class="space-y-2">
              <div class="text-sm font-medium text-dls-text">
                Sign in to OpenWork Cloud
              </div>
              <div class="max-w-[54ch] text-sm text-dls-secondary">
                Sign in to OpenWork Cloud to keep your tasks alive even when your
                computer sleeps.
              </div>
            </div>

          <div class="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => openBrowserAuth("sign-in")}>
              Sign in
              <ArrowUpRight size={13} />
            </Button>
            <Button
              variant="outline"
              class="text-xs h-9 px-3"
              onClick={() => openBrowserAuth("sign-up")}
            >
              Create account
              <ArrowUpRight size={13} />
            </Button>
            <Button
              variant="outline"
              class="text-xs h-9 px-3"
              onClick={() => {
                setManualAuthOpen((value) => !value);
                setAuthError(null);
              }}
              disabled={authBusy() || sessionBusy()}
            >
              {manualAuthOpen() ? "Hide sign-in code" : "Paste sign-in code"}
            </Button>
          </div>

          <Show when={manualAuthOpen()}>
            <div class={`${settingsPanelSoftClass} space-y-3`}>
              <TextInput
                label="Sign-in link or one-time code"
                value={manualAuthInput()}
                onInput={(event) => setManualAuthInput(event.currentTarget.value)}
                placeholder="openwork://den-auth?... or pasted code"
                disabled={authBusy() || sessionBusy()}
                hint="If your browser doesn't bounce back into OpenWork automatically, paste the sign-in link or one-time code from OpenWork Cloud here."
              />
              <div class="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  class="text-xs h-9 px-3"
                  onClick={() => void submitManualAuth()}
                  disabled={authBusy() || sessionBusy() || !manualAuthInput().trim()}
                >
                  {authBusy() ? "Finishing..." : "Finish sign-in"}
                </Button>
                <div class="text-[11px] text-dls-secondary">
                  Accepts an <span class="font-mono">openwork://den-auth</span> link or the raw one-time grant.
                </div>
              </div>
            </div>
          </Show>

          <Show when={authError()}>
            {(value) => (
              <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
                {value()}
              </div>
            )}
          </Show>

          <div class={`${settingsPanelSoftClass} text-sm text-gray-10`}>
            Finish auth in your browser and OpenWork will reconnect here
            automatically.
          </div>
        </div>
      </Show>

      <Show when={isSignedIn()}>
        <div class="space-y-6">
          <div class={`${settingsPanelClass} space-y-4`}>
            <div>
              <div class="text-sm font-medium text-dls-text">Cloud account</div>
              <div class="mt-1 text-xs text-dls-secondary">
                Manage your connected account and organization.
              </div>
            </div>

            <div class="flex flex-col gap-3">
              <div class="ow-soft-card-quiet flex flex-col gap-3 rounded-xl p-3 sm:flex-row sm:items-center sm:justify-between">
                <div class="min-w-0">
                  <div class="truncate text-sm font-medium text-dls-text">
                    {user()?.name || user()?.email}
                  </div>
                  <div class="truncate text-xs text-dls-secondary">
                    {user()?.email}
                  </div>
                </div>
                <Button
                  variant="outline"
                  class={`h-10 px-4 text-sm shrink-0 ${quietControlClass}`}
                  onClick={() => void signOut()}
                  disabled={authBusy() || sessionBusy()}
                >
                  <LogOut size={13} class="mr-1.5" />
                  {authBusy() ? "Signing out..." : "Sign out"}
                </Button>
              </div>

              <div class="ow-soft-card-quiet flex flex-col gap-3 rounded-xl p-3 sm:flex-row sm:items-center sm:justify-between">
                <div class="min-w-0">
                  <div class="text-sm font-medium text-dls-text">Active org</div>
                  <div class="truncate text-xs text-dls-secondary">
                    Cloud workers and team templates are scoped to the selected org.
                  </div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <select
                    class={`ow-input h-10 max-w-[260px] rounded-xl px-4 py-2 text-sm font-medium text-dls-text ${quietControlClass}`}
                    value={activeOrgId()}
                    onChange={(event) => {
                      const nextId = event.currentTarget.value;
                      const nextOrg = orgs().find((org) => org.id === nextId) ?? null;
                      setActiveOrgId(nextId);
                      writeDenSettings({
                        baseUrl: props.developerMode ? baseUrl() : DEFAULT_DEN_BASE_URL,
                        authToken: authToken() || null,
                        activeOrgId: nextId || null,
                        activeOrgSlug: nextOrg?.slug ?? null,
                        activeOrgName: nextOrg?.name ?? null,
                      });
                      setStatusMessage(
                        `Switched to ${nextOrg?.name ?? "the selected org"}.`,
                      );
                    }}
                    disabled={orgsBusy() || orgs().length === 0}
                  >
                    <For each={orgs()}>
                      {(org) => (
                        <option value={org.id}>
                          {org.name} {org.role === "owner" ? "(Owner)" : "(Member)"}
                        </option>
                      )}
                    </For>
                  </select>
                  <Button
                    variant="outline"
                    class={`h-10 px-4 text-sm ${quietControlClass}`}
                    onClick={() => void refreshOrgs()}
                    disabled={orgsBusy()}
                  >
                    <RefreshCcw size={13} class={orgsBusy() ? "animate-spin" : ""} />
                  </Button>
                </div>
              </div>
            </div>

            <Show when={orgsError()}>
              {(value) => (
                <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
                  {value()}
                </div>
              )}
            </Show>
          </div>

          <div class={`${settingsPanelClass} space-y-4`}>
            <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <div class="flex items-center gap-2 text-sm font-medium text-dls-text">
                  <Server size={15} class="text-dls-secondary" />
                  Cloud workers
                </div>
                <div class="mt-1 text-xs text-dls-secondary">
                  Open workers directly into OpenWork using the same
                  remote-connect flow the app already uses elsewhere.
                </div>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <div class={sectionPillClass}>
                  <Users size={12} />
                  {activeOrgName()}
                </div>
                <Button
                  variant="outline"
                  class="h-8 px-3 text-xs"
                  onClick={() => void refreshWorkers()}
                  disabled={workersBusy() || !activeOrgId().trim()}
                >
                  <RefreshCcw size={13} class={workersBusy() ? "animate-spin" : ""} />
                  Refresh
                </Button>
              </div>
            </div>

            <Show when={workersError()}>
              {(value) => (
                <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
                  {value()}
                </div>
              )}
            </Show>

            <Show when={!workersBusy() && workers().length === 0}>
              <div class={`${settingsPanelSoftClass} border-dashed py-6 text-center text-sm text-dls-secondary`}>
                No cloud workers are visible for this org yet. Create one in
                Cloud, then refresh this tab.
              </div>
            </Show>

            <div class="space-y-1">
              <For each={workers()}>
                {(worker) => {
                  const status = createMemo(() => workerStatusMeta(worker.status));
                  return (
                    <div class="flex items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] transition-colors hover:bg-[#f8fafc]">
                      <div class="min-w-0 pr-4">
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="truncate font-medium text-dls-text">
                            {worker.workerName}
                          </span>
                          <span
                            class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusBadgeClass(status().tone)}`}
                          >
                            {status().label}
                          </span>
                          <Show when={worker.isMine}>
                            <span class={sectionPillClass}>
                              Mine
                            </span>
                          </Show>
                        </div>
                        <div class="mt-0.5 truncate text-[11px] text-dls-secondary">
                          {worker.provider ? `${worker.provider} worker` : "Cloud worker"}
                          <Show when={worker.instanceUrl}>
                            {(value) => <span> · {value()}</span>}
                          </Show>
                        </div>
                      </div>
                      <Button
                        variant="secondary"
                        class="h-8 px-4 text-xs shrink-0"
                        onClick={() =>
                          void handleOpenWorker(worker.workerId, worker.workerName)
                        }
                        disabled={openingWorkerId() !== null || !status().canOpen}
                        title={!status().canOpen ? "This worker is not ready to open yet." : undefined}
                      >
                        {openingWorkerId() === worker.workerId ? "Opening..." : "Open"}
                      </Button>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>

          <div class={`${settingsPanelClass} space-y-4`}>
            <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <div class="flex items-center gap-2 text-sm font-medium text-dls-text">
                  <Boxes size={15} class="text-dls-secondary" />
                  Team templates
                </div>
                <div class="mt-1 text-xs text-dls-secondary">
                  Open reusable workspace templates shared with this organization.
                </div>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <div class={sectionPillClass}>
                  <Users size={12} />
                  {activeOrgName()}
                </div>
                <Button
                  variant="outline"
                  class="h-8 px-3 text-xs"
                  onClick={() => void refreshTemplates()}
                  disabled={templatesBusy() || !activeOrg()?.slug?.trim()}
                >
                  <RefreshCcw size={13} class={templatesBusy() ? "animate-spin" : ""} />
                  Refresh
                </Button>
              </div>
            </div>

            <Show when={templatesError()}>
              {(value) => (
                <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
                  {value()}
                </div>
              )}
            </Show>

            <Show when={!templatesBusy() && templates().length === 0}>
              <div class={`${settingsPanelSoftClass} border-dashed py-6 text-center text-sm text-dls-secondary`}>
                <Show
                  when={activeOrg()?.slug?.trim()}
                  fallback={"Choose an org to view team templates."}
                >
                  No team templates yet. Use Share -&gt; Template -&gt; Share with team.
                </Show>
              </div>
            </Show>

            <div class="space-y-1">
              <For each={templates()}>
                {(template) => {
                  const isMine = () => template.creator?.userId === user()?.id;
                  const opening = () => openingTemplateId() === template.id;
                  return (
                    <div class="flex items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] transition-colors hover:bg-[#f8fafc]">
                      <div class="min-w-0 pr-4">
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="truncate font-medium text-dls-text">
                            {template.name}
                          </span>
                          <span class={sectionPillClass}>
                            Team template
                          </span>
                          <Show when={isMine()}>
                            <span class={sectionPillClass}>
                              Mine
                            </span>
                          </Show>
                        </div>
                        <div class="mt-0.5 truncate text-[11px] text-dls-secondary">
                          by {templateCreatorLabel(template)} · {formatTemplateTimestamp(template.createdAt)}
                        </div>
                      </div>
                      <Button
                        variant="secondary"
                        class="h-8 px-4 text-xs shrink-0"
                        onClick={() => void handleOpenTemplate(template)}
                        disabled={openingTemplateId() !== null}
                      >
                        {opening() ? "Opening..." : "Open"}
                      </Button>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
