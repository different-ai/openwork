/** @jsxImportSource react */
import * as React from "react";
import { ArrowUpRight } from "lucide-react";

import {
  buildDenAuthUrl,
  clearDenSession,
  DEFAULT_DEN_BASE_URL,
  DenApiError,
  type DenOrgMarketplaceResolved,
  type DenOrgLlmProvider,
  type DenOrgPlugin,
  type DenOrgSkillHub,
  type DenUser,
  createDenClient,
  ensureDenActiveOrganization,
  normalizeDenBaseUrl,
  readDenSettings,
  resolveDenBaseUrls,
  writeDenSettings,
} from "../../../../app/lib/den";
import {
  denSessionUpdatedEvent,
  dispatchDenSessionUpdated,
  type DenSessionUpdatedDetail,
} from "../../../../app/lib/den-session-events";
import type { CloudImportedPlugin, CloudImportedProvider, CloudImportedSkill, CloudImportedSkillHub } from "../../../../app/cloud/import-state";
import type { DenOrgSkillCard, SkillCard } from "../../../../app/types";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  CloudProvidersSection,
  CloudSkillsSection,
  CloudWorkersSection,
  MarketplacePluginsSection,
  SkillHubsSection,
  type CloudPluginRow,
  type CloudProviderRow,
  type CloudSkillHubRow,
  type CloudSkillRow,
} from "../cloud/sections";
import { CloudAccountSection } from "../cloud/cloud-account-section";
import { CloudDevMode } from "../cloud/dev-mode";
import {
  SettingsSection,
  SettingsInset,
  SettingsNotice,
  SettingsSectionHeader,
  SettingsSectionHeaderActions,
  SettingsSectionHeaderContent,
  SettingsSectionHeaderDescription,
  SettingsSectionHeaderTitle,
  SettingsStack,
  SettingsStatusBadge,
} from "../settings-section";
import { useStatusToasts } from "../../shell-feedback/status-toasts";
import { t } from "@/i18n";

type AsyncResult = { ok: boolean; message: string };

export type DenSettingsExtensionsStore = {
  skills: () => SkillCard[];
  cloudOrgSkills: () => DenOrgSkillCard[];
  cloudOrgSkillsStatus: () => string | null;
  importedCloudSkills: () => Record<string, CloudImportedSkill>;
  refreshCloudOrgSkills: (options?: { force?: boolean }) => Promise<unknown>;
  installCloudOrgSkill: (skill: DenOrgSkillCard) => Promise<AsyncResult>;
  removeCloudOrgSkill: (cloudSkillId: string) => Promise<AsyncResult>;
  syncCloudOrgSkill: (skill: DenOrgSkillCard) => Promise<AsyncResult>;
  cloudOrgSkillHubs: () => DenOrgSkillHub[];
  cloudOrgSkillHubsStatus: () => string | null;
  importedCloudSkillHubs: () => Record<string, CloudImportedSkillHub>;
  refreshCloudOrgSkillHubs: (options?: { force?: boolean }) => Promise<unknown>;
  importCloudOrgSkillHub: (hub: DenOrgSkillHub) => Promise<AsyncResult>;
  removeCloudOrgSkillHub: (hubId: string) => Promise<AsyncResult>;
  syncCloudOrgSkillHub: (hub: DenOrgSkillHub) => Promise<AsyncResult>;
  cloudOrgMarketplaces: () => DenOrgMarketplaceResolved[];
  cloudOrgMarketplacesStatus: () => string | null;
  importedCloudPlugins: () => Record<string, CloudImportedPlugin>;
  refreshCloudOrgMarketplaces: (options?: { force?: boolean }) => Promise<unknown>;
  importCloudOrgPlugin: (marketplaceId: string | null, plugin: DenOrgPlugin) => Promise<AsyncResult>;
};

export type DenSettingsPanelProps = {
  developerMode: boolean;
  extensions: DenSettingsExtensionsStore;
  openLink: (url: string) => void;
  connectRemoteWorkspace: (input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => Promise<boolean>;
  cloudOrgProviders: DenOrgLlmProvider[];
  importedCloudProviders: Record<string, CloudImportedProvider>;
  refreshCloudOrgProviders: (options?: { force?: boolean }) => Promise<DenOrgLlmProvider[]>;
  connectCloudProvider: (cloudProviderId: string) => Promise<string | void>;
  removeCloudProvider: (cloudProviderId: string) => Promise<string | void>;
};

const sortStrings = (values: string[]) => values.toSorted();

const sameStringList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

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
      (routeHost === "den-auth" || routePath === "den-auth" || routeTail === "den-auth")
    ) {
      const grant = url.searchParams.get("grant")?.trim() ?? "";
      const nextBaseUrl =
        normalizeDenBaseUrl(url.searchParams.get("denBaseUrl")?.trim() ?? "") ?? undefined;
      return grant ? { grant, baseUrl: nextBaseUrl } : null;
    }
  } catch {
    // Treat non-URL input as a raw handoff grant.
  }

  return trimmed.length >= 12 ? { grant: trimmed } : null;
}

interface DenSignedOutPanelProps {
  authBusy: boolean;
  authError: string | null;
  onClearAuthError: () => void;
  onOpenBrowserAuth: (mode: "sign-in" | "sign-up") => void;
  onSubmitManualAuth: (input: string) => Promise<boolean>;
  sessionBusy: boolean;
}

function DenSignedOutPanel({
  authBusy,
  authError,
  onClearAuthError,
  onOpenBrowserAuth,
  onSubmitManualAuth,
  sessionBusy,
}: DenSignedOutPanelProps) {
  const [manualAuthOpen, setManualAuthOpen] = React.useState(false);
  const [manualAuthInput, setManualAuthInput] = React.useState("");
  const controlsDisabled = [authBusy, sessionBusy].some(Boolean);

  const submitManualAuth = async () => {
    const ok = await onSubmitManualAuth(manualAuthInput);
    if (!ok) return;
    setManualAuthInput("");
    setManualAuthOpen(false);
  };

  return (
    <SettingsSection>
      <SettingsSectionHeader>
        <SettingsSectionHeaderContent>
          <SettingsSectionHeaderTitle>{t("den.signin_title")}</SettingsSectionHeaderTitle>
          <SettingsSectionHeaderDescription className="max-w-[54ch]">
            {t("den.cloud_sleep_hint")}
          </SettingsSectionHeaderDescription>
        </SettingsSectionHeaderContent>
      </SettingsSectionHeader>

      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => onOpenBrowserAuth("sign-in")}>
            {t("den.signin_button")}
            <ArrowUpRight size={13} />
          </Button>
          <Button variant="outline" onClick={() => onOpenBrowserAuth("sign-up")}>
            {t("den.create_account")}
            <ArrowUpRight size={13} />
          </Button>
        </div>

        <Collapsible
          open={manualAuthOpen}
          onOpenChange={(open) => {
            setManualAuthOpen(open);
            onClearAuthError();
          }}
          disabled={controlsDisabled}
          className="flex flex-col gap-3"
        >
          <CollapsibleTrigger
            render={<Button variant="ghost" size="sm" className="w-fit self-start" disabled={controlsDisabled} />}
          >
            {manualAuthOpen ? t("den.hide_signin_code") : t("den.paste_signin_code")}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <SettingsInset className="flex flex-col gap-y-3">
              <Field data-disabled={controlsDisabled}>
                <FieldLabel htmlFor="den-signin-link">{t("den.signin_link_label")}</FieldLabel>
                <Input
                  id="den-signin-link"
                  value={manualAuthInput}
                  onChange={(event) => setManualAuthInput(event.currentTarget.value)}
                  placeholder={t("den.signin_link_placeholder")}
                  disabled={controlsDisabled}
                />
                <FieldDescription className="text-xs">{t("den.signin_link_hint")}</FieldDescription>
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={() => void submitManualAuth()}
                  disabled={[controlsDisabled, !manualAuthInput.trim()].some(Boolean)}
                >
                  {authBusy ? t("den.finishing") : t("den.finish_signin")}
                </Button>
              </div>
            </SettingsInset>
          </CollapsibleContent>
        </Collapsible>
      </div>

      {authError ? <SettingsNotice tone="error">{authError}</SettingsNotice> : null}

      <SettingsInset className="text-sm text-gray-10">
        {t("den.auto_reconnect_hint")}
      </SettingsInset>
    </SettingsSection>
  );
}

export function DenSettingsPanel(props: DenSettingsPanelProps) {
  const { showToast } = useStatusToasts();

  const initial = React.useMemo(() => readDenSettings(), []);
  const initialBaseUrl = initial.baseUrl || DEFAULT_DEN_BASE_URL;

  // Connection settings
  const [baseUrl, setBaseUrl] = React.useState(initialBaseUrl);
  const [baseUrlDraft, setBaseUrlDraft] = React.useState(initialBaseUrl);
  const [baseUrlError, setBaseUrlError] = React.useState<string | null>(null);
  const [authToken, setAuthToken] = React.useState(initial.authToken?.trim() || "");
  const client = React.useMemo(
    () => createDenClient({ baseUrl, token: authToken }),
    [authToken, baseUrl],
  );

  // Auth session
  const [authBusy, setAuthBusy] = React.useState(false);
  const [sessionBusy, setSessionBusy] = React.useState(false);
  const [user, setUser] = React.useState<DenUser | null>(null);
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null);
  const [authError, setAuthError] = React.useState<string | null>(null);

  // Organizations
  const [activeOrgId, setActiveOrgId] = React.useState(initial.activeOrgId?.trim() || "");
  const [orgsBusy, setOrgsBusy] = React.useState(false);
  const [orgs, setOrgs] = React.useState<
    Array<{ id: string; name: string; slug: string; role: "owner" | "admin" | "member" }>
  >([]);
  const [orgsError, setOrgsError] = React.useState<string | null>(null);
  const activeOrg = React.useMemo(
    () => orgs.find((org) => org.id === activeOrgId) ?? null,
    [activeOrgId, orgs],
  );
  const activeOrgName = activeOrg?.name || t("den.no_org_selected");

  // Workers
  const [workersBusy, setWorkersBusy] = React.useState(false);
  const [openingWorkerId, setOpeningWorkerId] = React.useState<string | null>(null);
  const [workers, setWorkers] = React.useState<
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
  const [workersError, setWorkersError] = React.useState<string | null>(null);

  // Skill hubs
  const [skillHubsBusy, setSkillHubsBusy] = React.useState(false);
  const [skillHubActionId, setSkillHubActionId] = React.useState<string | null>(null);
  const [skillHubActionKind, setSkillHubActionKind] = React.useState<"import" | "remove" | "sync" | null>(null);
  const [skillHubActionError, setSkillHubActionError] = React.useState<string | null>(null);

  // Skills
  const [skillsBusy, setSkillsBusy] = React.useState(false);
  const [skillActionId, setSkillActionId] = React.useState<string | null>(null);
  const [skillActionKind, setSkillActionKind] = React.useState<"import" | "remove" | "sync" | null>(null);
  const [skillActionError, setSkillActionError] = React.useState<string | null>(null);

  // Marketplaces and plugins
  const [marketplacesBusy, setMarketplacesBusy] = React.useState(false);
  const [activeMarketplaceId, setActiveMarketplaceId] = React.useState<string | null>(null);
  const [pluginActionId, setPluginActionId] = React.useState<string | null>(null);
  const [pluginActionError, setPluginActionError] = React.useState<string | null>(null);

  // Providers
  const [providersBusy, setProvidersBusy] = React.useState(false);
  const [providerActionId, setProviderActionId] = React.useState<string | null>(null);
  const [providerActionKind, setProviderActionKind] = React.useState<"import" | "remove" | "sync" | null>(null);
  const [providerActionError, setProviderActionError] = React.useState<string | null>(null);

  const isSignedIn = Boolean(user && authToken.trim());

  const syncCurrentDenSettings = React.useCallback(() => {
    const resolved = resolveDenBaseUrls(baseUrl);
    writeDenSettings({
      baseUrl: resolved.baseUrl,
      apiBaseUrl: resolved.apiBaseUrl,
      authToken: authToken || null,
      activeOrgId: activeOrgId || null,
      activeOrgSlug: activeOrg?.slug ?? null,
      activeOrgName: activeOrg?.name ?? null,
    });
  }, [activeOrg, activeOrgId, authToken, baseUrl]);

  // Derived extension rows
  const installedSkillNames = React.useMemo(
    () => new Set(props.extensions.skills().map((skill) => skill.name)),
    [props.extensions],
  );

  const skillHubImports = props.extensions.importedCloudSkillHubs();
  const liveSkillHubs = props.extensions.cloudOrgSkillHubs();
  const liveSkills = props.extensions.cloudOrgSkills();
  const importedSkills = props.extensions.importedCloudSkills();
  const liveMarketplaces = props.extensions.cloudOrgMarketplaces();
  const importedPlugins = props.extensions.importedCloudPlugins();

  const skillHubRows = React.useMemo<CloudSkillHubRow[]>(() => {
    const rows: CloudSkillHubRow[] = liveSkillHubs.map((hub) => {
      const imported = skillHubImports[hub.id] ?? null;
      const currentSkillIds = sortStrings(hub.skills.map((skill) => skill.id));
      const importedSkillIds = sortStrings(imported?.skillIds ?? []);
      const status = !imported
        ? "available"
        : sameStringList(currentSkillIds, importedSkillIds)
          ? "imported"
          : "out_of_sync";
      return {
        key: `live:${hub.id}`,
        hubId: hub.id,
        name: hub.name,
        hub,
        imported,
        status,
        liveSkillCount: hub.skills.length,
        importedSkillCount: imported?.skillNames.length ?? 0,
      };
    });

    for (const imported of Object.values(skillHubImports)) {
      if (liveSkillHubs.some((hub) => hub.id === imported.hubId)) continue;
      rows.push({
        key: `imported:${imported.hubId}`,
        hubId: imported.hubId,
        name: imported.name,
        hub: null,
        imported,
        status: "removed_from_cloud",
        liveSkillCount: 0,
        importedSkillCount: imported.skillNames.length,
      });
    }

    return rows;
  }, [liveSkillHubs, skillHubImports]);

  const skillRows = React.useMemo<CloudSkillRow[]>(() => {
    const rows: CloudSkillRow[] = liveSkills.map((skill) => {
      const imported = importedSkills[skill.id] ?? null;
      const remoteUpdatedAt = skill.updatedAt ? Date.parse(skill.updatedAt) : Number.NaN;
      const importedUpdatedAt = imported?.updatedAt ? Date.parse(imported.updatedAt) : Number.NaN;
      const installedName = imported?.installedName?.trim() || null;
      const installedLocally = installedName ? installedSkillNames.has(installedName) : false;
      const status = !imported
        ? "available"
        : !installedLocally
          ? "out_of_sync"
          : Number.isFinite(remoteUpdatedAt) &&
              (!Number.isFinite(importedUpdatedAt) || remoteUpdatedAt > importedUpdatedAt)
            ? "out_of_sync"
            : "installed";

      return {
        key: `live:${skill.id}`,
        cloudSkillId: skill.id,
        skill,
        imported,
        status,
        title: skill.title,
        installedName,
      };
    });

    for (const imported of Object.values(importedSkills)) {
      if (liveSkills.some((skill) => skill.id === imported.cloudSkillId)) continue;
      rows.push({
        key: `imported:${imported.cloudSkillId}`,
        cloudSkillId: imported.cloudSkillId,
        skill: null,
        imported,
        status: "removed_from_cloud",
        title: imported.title,
        installedName: imported.installedName,
      });
    }

    return rows.sort((a, b) => a.title.localeCompare(b.title));
  }, [importedSkills, installedSkillNames, liveSkills]);

  const providerRows = React.useMemo<CloudProviderRow[]>(() => {
    const rows: CloudProviderRow[] = props.cloudOrgProviders.map((provider) => {
      const imported = props.importedCloudProviders[provider.id] ?? null;
      const status = !imported
        ? "available"
        : imported.providerId !== provider.providerId ||
            (imported.source ?? null) !== provider.source ||
            (imported.updatedAt ?? null) !== (provider.updatedAt ?? null) ||
            !sameStringList(imported.modelIds, sortStrings(provider.models.map((model) => model.id)))
          ? "out_of_sync"
          : "imported";
      return {
        key: `live:${provider.id}`,
        cloudProviderId: provider.id,
        provider,
        imported,
        status,
        name: provider.name,
      };
    });

    for (const imported of Object.values(props.importedCloudProviders)) {
      if (props.cloudOrgProviders.some((provider) => provider.id === imported.cloudProviderId)) continue;
      rows.push({
        key: `imported:${imported.cloudProviderId}`,
        cloudProviderId: imported.cloudProviderId,
        provider: null,
        imported,
        status: "removed_from_cloud",
        name: imported.name,
      });
    }

    return rows;
  }, [props.cloudOrgProviders, props.importedCloudProviders]);

  const marketplacePluginRows = React.useMemo<Record<string, CloudPluginRow[]>>(() => {
    const next: Record<string, CloudPluginRow[]> = {};
    for (const marketplace of liveMarketplaces) {
      next[marketplace.marketplace.id] = marketplace.plugins.map((plugin) => {
        const imported = importedPlugins[plugin.id] ?? null;
        const status = !imported
          ? "available"
          : imported.updatedAt !== plugin.updatedAt || imported.files.length !== plugin.memberCount
            ? "out_of_sync"
            : "imported";
        return { marketplaceId: marketplace.marketplace.id, plugin, imported, status };
      });
    }
    return next;
  }, [importedPlugins, liveMarketplaces]);

  // Summary status
  const summaryTone = React.useMemo(() => {
    if (
      authError ||
      workersError ||
      orgsError ||
      skillActionError ||
      pluginActionError ||
      providerActionError ||
      skillHubActionError
    ) {
      return "error" as const;
    }
    if (
      sessionBusy ||
      orgsBusy ||
      workersBusy ||
      skillsBusy ||
      marketplacesBusy ||
      providersBusy ||
      skillHubsBusy
    ) {
      return "warning" as const;
    }
    if (isSignedIn) return "ready" as const;
    return "neutral" as const;
  }, [
    authError,
    isSignedIn,
    orgsBusy,
    orgsError,
    marketplacesBusy,
    providerActionError,
    providersBusy,
    pluginActionError,
    sessionBusy,
    skillActionError,
    skillHubActionError,
    skillHubsBusy,
    skillsBusy,
    workersBusy,
    workersError,
  ]);

  const summaryLabel = React.useMemo(() => {
    if (authError) return t("den.needs_attention");
    if (sessionBusy) return t("den.checking_session");
    if (isSignedIn) return t("dashboard.connected");
    return t("den.signed_out");
  }, [authError, isSignedIn, sessionBusy]);

  // Shared reset helpers
  const clearSessionState = React.useCallback(() => {
    setUser(null);
    setOrgs([]);
    setWorkers([]);
    setActiveOrgId("");
    setActiveMarketplaceId(null);
    setOrgsError(null);
    setWorkersError(null);
    setSkillHubActionError(null);
    setPluginActionError(null);
    setProviderActionError(null);
    setSkillHubActionKind(null);
    setProviderActionKind(null);
  }, []);

  const clearSignedInState = React.useCallback(
    (message?: string | null) => {
      clearDenSession({ includeBaseUrls: !props.developerMode });
      if (!props.developerMode) {
        setBaseUrl(DEFAULT_DEN_BASE_URL);
        setBaseUrlDraft(DEFAULT_DEN_BASE_URL);
      }
      setAuthToken("");
      setOpeningWorkerId(null);
      setSkillHubActionId(null);
      setPluginActionId(null);
      setProviderActionId(null);
      setSkillHubActionKind(null);
      setProviderActionKind(null);
      clearSessionState();
      setBaseUrlError(null);
      setAuthError(null);
      setStatusMessage(message ?? null);
    },
    [clearSessionState, props.developerMode],
  );

  // Settings persistence
  React.useEffect(() => {
    syncCurrentDenSettings();
  }, [syncCurrentDenSettings]);

  // Connection settings actions
  const openControlPlane = React.useCallback(() => {
    props.openLink(resolveDenBaseUrls(baseUrl).baseUrl);
  }, [baseUrl, props]);

  const openBrowserAuth = React.useCallback(
    (mode: "sign-in" | "sign-up") => {
      props.openLink(buildDenAuthUrl(baseUrl, mode));
      setStatusMessage(
        mode === "sign-up"
          ? t("den.status_browser_signup")
          : t("den.status_browser_signin"),
      );
      setAuthError(null);
    },
    [baseUrl, props],
  );

  const applyBaseUrl = React.useCallback(() => {
    const normalized = normalizeDenBaseUrl(baseUrlDraft);
    if (!normalized) {
      setBaseUrlError(t("den.error_base_url"));
      return;
    }

    const resolved = resolveDenBaseUrls(normalized);
    setBaseUrlError(null);
    if (resolved.baseUrl === baseUrl) {
      setBaseUrlDraft(resolved.baseUrl);
      return;
    }

    setBaseUrl(resolved.baseUrl);
    setBaseUrlDraft(resolved.baseUrl);
    clearSignedInState(t("den.status_base_url_updated"));
  }, [baseUrl, baseUrlDraft, clearSignedInState]);

  // Auth session query candidate: user, sessionBusy, authError
  React.useEffect(() => {
    const token = authToken.trim();
    if (!token) {
      setSessionBusy(false);
      clearSessionState();
      setAuthError(null);
      return;
    }

    let cancelled = false;
    setSessionBusy(true);
    setAuthError(null);

    void createDenClient({ baseUrl, token })
      .getSession()
      .then((nextUser) => {
        if (cancelled) return;
        setUser(nextUser);
        setStatusMessage(t("den.status_signed_in_as", { email: nextUser.email }));
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof DenApiError && error.status === 401) {
          clearSignedInState();
        } else {
          clearSessionState();
        }
        setAuthError(error instanceof Error ? error.message : t("den.error_no_session"));
      })
      .finally(() => {
        if (!cancelled) setSessionBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authToken, baseUrl, clearSessionState, clearSignedInState]);

  // Organizations query candidate: orgs, orgsBusy, orgsError
  const refreshOrgs = React.useCallback(
    async (quiet = false) => {
      if (!authToken.trim()) {
        setOrgs([]);
        setActiveOrgId("");
        return;
      }

      setOrgsBusy(true);
      if (!quiet) setOrgsError(null);

      try {
        const response = await client.listOrgs();
        setOrgs(response.orgs);
        const current = activeOrgId.trim();
        const fallback = response.defaultOrgId ?? response.orgs[0]?.id ?? "";
        const next = response.orgs.some((org) => org.id === current) ? current : fallback;
        const nextOrg = response.orgs.find((org) => org.id === next) ?? null;
        setActiveOrgId(next);
        writeDenSettings({
          baseUrl,
          authToken: authToken || null,
          activeOrgId: next || null,
          activeOrgSlug: nextOrg?.slug ?? null,
          activeOrgName: nextOrg?.name ?? null,
        });
        // Keep Better-Auth's active org in sync so subsequent /v1/org/* requests
        // resolve against `next` instead of whatever the session picked last.
        // Mirrors the Solid flow (ac41d58b "feat(den): use Better Auth active
        // org context").
        if (next) {
          await ensureDenActiveOrganization({ forceServerSync: true }).catch(
            () => null,
          );
        }
        if (!quiet && response.orgs.length > 0) {
          showToast({
            title: t("den.status_loaded_orgs", {
              count: response.orgs.length,
            }),
            tone: "info",
          });
        }
      } catch (error) {
        setOrgsError(error instanceof Error ? error.message : t("den.error_load_orgs"));
      } finally {
        setOrgsBusy(false);
      }
    },
    [activeOrgId, authToken, baseUrl, client, showToast],
  );

  React.useEffect(() => {
    if (!user) return;
    void refreshOrgs(true);
  }, [refreshOrgs, user]);

  // Workers query candidate: workers, workersBusy, workersError
  const refreshWorkers = React.useCallback(
    async (quiet = false) => {
      const orgId = activeOrgId.trim();
      if (!authToken.trim() || !orgId) {
        setWorkers([]);
        return;
      }

      setWorkersBusy(true);
      if (!quiet) setWorkersError(null);

      try {
        const nextWorkers = await client.listWorkers(orgId, 20);
        setWorkers(nextWorkers);
        if (!quiet) {
          showToast({
            title: nextWorkers.length > 0
              ? t("den.status_loaded_workers", {
                  count: nextWorkers.length,
                  name: activeOrg?.name ?? t("den.active_org_title"),
                })
              : t("den.status_no_workers", {
                  name: activeOrg?.name ?? t("den.active_org_title"),
                }),
            tone: "info",
          });
        }
      } catch (error) {
        setWorkersError(error instanceof Error ? error.message : t("den.error_load_workers"));
      } finally {
        setWorkersBusy(false);
      }
    },
    [activeOrg, activeOrgId, authToken, client, showToast],
  );

  React.useEffect(() => {
    if (!user || !activeOrgId.trim()) return;
    void refreshWorkers(true);
  }, [activeOrgId, refreshWorkers, user]);

  // Skill hubs query candidate: skillHubsBusy, skillHubActionError
  const refreshSkillHubs = React.useCallback(
    async (quiet = false) => {
      const orgId = activeOrgId.trim();
      if (!authToken.trim() || !orgId) return;

      setSkillHubsBusy(true);
      if (!quiet) setSkillHubActionError(null);

      try {
        syncCurrentDenSettings();
        await props.extensions.refreshCloudOrgSkillHubs({ force: true });
        if (!quiet) {
          const count = props.extensions.cloudOrgSkillHubs().length;
          showToast({
            title: count > 0
              ? `Loaded ${count} cloud skill hub${count === 1 ? "" : "s"} for ${activeOrg?.name ?? t("den.active_org_title")}.`
              : `No cloud skill hubs are available for ${activeOrg?.name ?? t("den.active_org_title")}.`,
            tone: "info",
          });
        }
      } catch (error) {
        if (!quiet) {
          setSkillHubActionError(
            error instanceof Error ? error.message : "Failed to load cloud skill hubs.",
          );
        }
      } finally {
        setSkillHubsBusy(false);
      }
    },
    [activeOrg, activeOrgId, authToken, props.extensions, syncCurrentDenSettings],
  );

  React.useEffect(() => {
    if (!user || !activeOrgId.trim()) return;
    void refreshSkillHubs(true);
  }, [activeOrgId, refreshSkillHubs, user]);

  // Skills query candidate: skillsBusy, skillActionError
  const refreshSkills = React.useCallback(
    async (quiet = false) => {
      const orgId = activeOrgId.trim();
      if (!authToken.trim() || !orgId) return;

      setSkillsBusy(true);
      if (!quiet) setSkillActionError(null);

      try {
        syncCurrentDenSettings();
        await props.extensions.refreshCloudOrgSkills({ force: true });
        if (!quiet) {
          const count = props.extensions.cloudOrgSkills().length;
          showToast({
            title: count > 0
              ? t("den.status_loaded_skills", {
                  count,
                  name: activeOrg?.name ?? t("den.active_org_title"),
                })
              : t("den.status_no_skills", {
                  name: activeOrg?.name ?? t("den.active_org_title"),
                }),
            tone: "info",
          });
        }
      } catch (error) {
        if (!quiet) {
          setSkillActionError(error instanceof Error ? error.message : t("den.error_load_skills"));
        }
      } finally {
        setSkillsBusy(false);
      }
    },
    [activeOrg, activeOrgId, authToken, props.extensions, syncCurrentDenSettings],
  );

  React.useEffect(() => {
    if (!user || !activeOrgId.trim()) return;
    void refreshSkills(true);
  }, [activeOrgId, refreshSkills, user]);

  // Marketplaces query candidate: marketplacesBusy, pluginActionError
  const refreshMarketplaces = React.useCallback(
    async (quiet = false) => {
      const orgId = activeOrgId.trim();
      if (!authToken.trim() || !orgId) return;

      setMarketplacesBusy(true);
      if (!quiet) setPluginActionError(null);

      try {
        await props.extensions.refreshCloudOrgMarketplaces({ force: true });
        if (!quiet) {
          const count = props.extensions.cloudOrgMarketplaces().length;
          showToast({
            title: count > 0
              ? `Loaded ${count} marketplace${count === 1 ? "" : "s"} for ${activeOrg?.name ?? t("den.active_org_title")}.`
              : `No marketplaces are available for ${activeOrg?.name ?? t("den.active_org_title")}.`,
            tone: "info",
          });
        }
      } catch (error) {
        if (!quiet) {
          setPluginActionError(error instanceof Error ? error.message : "Failed to load marketplaces.");
        }
      } finally {
        setMarketplacesBusy(false);
      }
    },
    [activeOrg, activeOrgId, authToken, props.extensions, showToast],
  );

  React.useEffect(() => {
    if (!user || !activeOrgId.trim()) return;
    void refreshMarketplaces(true);
  }, [activeOrgId, refreshMarketplaces, user]);

  // Providers query candidate: providersBusy, providerActionError
  const refreshProviders = React.useCallback(
    async (quiet = false) => {
      const orgId = activeOrgId.trim();
      if (!authToken.trim() || !orgId) return;

      setProvidersBusy(true);
      setProviderActionError(null);

      try {
        syncCurrentDenSettings();
        const items = await props.refreshCloudOrgProviders({ force: !quiet });
        if (!quiet) {
          showToast({
            title: items.length > 0
              ? `Loaded ${items.length} cloud provider${items.length === 1 ? "" : "s"} for ${activeOrg?.name ?? t("den.active_org_title")}.`
              : `No cloud providers are available for ${activeOrg?.name ?? t("den.active_org_title")}.`,
            tone: "info",
          });
        }
      } catch (error) {
        if (!quiet) {
          setProviderActionError(
            error instanceof Error ? error.message : "Failed to load cloud providers.",
          );
        }
      } finally {
        setProvidersBusy(false);
      }
    },
    [activeOrg, activeOrgId, authToken, props, syncCurrentDenSettings],
  );

  React.useEffect(() => {
    if (!user || !activeOrgId.trim()) return;
    void refreshProviders(true);
  }, [activeOrgId, refreshProviders, user]);

  // External auth handoff events
  React.useEffect(() => {
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<DenSessionUpdatedDetail>;
      const nextSettings = readDenSettings();
      const nextBaseUrl =
        customEvent.detail?.baseUrl?.trim() || nextSettings.baseUrl || DEFAULT_DEN_BASE_URL;
      const nextToken =
        customEvent.detail?.token?.trim() || nextSettings.authToken?.trim() || "";
      setBaseUrl(nextBaseUrl);
      setBaseUrlDraft(nextBaseUrl);
      setAuthToken(nextToken);
      setActiveOrgId(nextSettings.activeOrgId?.trim() || "");
      if (customEvent.detail?.status === "success") {
        clearSessionState();
        if (customEvent.detail.user) {
          setUser(customEvent.detail.user);
        }
        setAuthError(null);
        setSessionBusy(false);
        setStatusMessage(
          customEvent.detail.email?.trim()
            ? t("den.status_cloud_signed_in_as", { email: customEvent.detail.email.trim() })
            : t("den.status_cloud_signin_done"),
        );
      } else if (customEvent.detail?.status === "error") {
        setAuthError(customEvent.detail.message?.trim() || t("den.error_signin_failed"));
      }
    };

    window.addEventListener(denSessionUpdatedEvent, handler as EventListener);
    return () => window.removeEventListener(denSessionUpdatedEvent, handler as EventListener);
  }, [clearSessionState]);

  // Auth mutations: manual sign-in and sign-out
  const submitManualAuth = React.useCallback(async (input: string) => {
    const parsed = parseManualAuthInput(input);
    if (!parsed || authBusy) {
      if (!parsed) setAuthError(t("den.error_paste_valid_code"));
      return false;
    }

    const nextBaseUrl = parsed.baseUrl ?? baseUrl;
    setAuthBusy(true);
    setAuthError(null);
    setStatusMessage(t("den.signing_in"));

    try {
      const result = await createDenClient({ baseUrl: nextBaseUrl }).exchangeDesktopHandoff(parsed.grant);
      if (!result.token) {
        throw new Error(t("den.error_no_token"));
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

      dispatchDenSessionUpdated({
        status: "success",
        baseUrl: nextBaseUrl,
        token: result.token,
        user: result.user,
        email: result.user?.email ?? null,
      });
      return true;
    } catch (error) {
      dispatchDenSessionUpdated({
        status: "error",
        message: error instanceof Error ? error.message : t("den.error_signin_failed"),
      });
      return false;
    } finally {
      setAuthBusy(false);
    }
  }, [authBusy, baseUrl, props.developerMode]);

  const signOut = React.useCallback(async () => {
    if (authBusy) return;

    setAuthBusy(true);
    try {
      if (authToken.trim()) {
        await client.signOut();
      }
    } catch {
      // Ignore remote sign-out failures.
    } finally {
      setAuthBusy(false);
    }

    clearSignedInState(t("den.status_signed_out"));
  }, [authBusy, authToken, clearSignedInState, client]);

  // Organization mutation: active org switch
  const handleActiveOrgChange = React.useCallback(
    (nextId: string) => {
      const nextOrg = orgs.find((org) => org.id === nextId) ?? null;
      setActiveOrgId(nextId);
      writeDenSettings({
        baseUrl,
        authToken: authToken ? authToken : null,
        activeOrgId: nextId ? nextId : null,
        activeOrgSlug: nextOrg?.slug ?? null,
        activeOrgName: nextOrg?.name ?? null,
      });
      // Sync Better-Auth's active org so the next request resolves against `nextId`.
      if (nextId) {
        void ensureDenActiveOrganization({
          forceServerSync: true,
        }).catch(() => null);
      }
      showToast({
        title: t("den.org_switched", { name: nextOrg?.name ?? t("den.active_org_title") }),
        tone: "success",
      });
    },
    [authToken, baseUrl, orgs, showToast],
  );

  // Worker mutation: open remote workspace
  const handleOpenWorker = React.useCallback(
    async (workerId: string, workerName: string) => {
      const orgId = activeOrgId.trim();
      if (!orgId) {
        setWorkersError(t("den.error_choose_org"));
        return;
      }

      setOpeningWorkerId(workerId);
      setWorkersError(null);

      try {
        const tokens = await client.getWorkerTokens(workerId, orgId);
        const openworkUrl = tokens.openworkUrl?.trim() ?? "";
        const accessToken = tokens.ownerToken?.trim() || tokens.clientToken?.trim() || "";
        if (!openworkUrl || !accessToken) {
          throw new Error(t("den.error_worker_not_ready"));
        }

        const ok = await props.connectRemoteWorkspace({
          openworkHostUrl: openworkUrl,
          openworkToken: accessToken,
          directory: null,
          displayName: workerName,
        });
        if (!ok) {
          throw new Error(t("den.error_open_worker", { name: workerName }));
        }

        showToast({
          title: t("den.status_opened_worker", { name: workerName }),
          tone: "success",
        });
      } catch (error) {
        setWorkersError(
          error instanceof Error
            ? error.message
            : t("den.error_open_worker_fallback", { name: workerName }),
        );
      } finally {
        setOpeningWorkerId(null);
      }
    },
    [activeOrgId, client, props, showToast],
  );

  // Skill hub mutations
  const handleImportSkillHub = React.useCallback(
    async (hubId: string) => {
      const hub = props.extensions.cloudOrgSkillHubs().find((entry) => entry.id === hubId);
      if (!hub || skillHubActionId) return;

      setSkillHubActionId(hub.id);
      setSkillHubActionKind("import");
      setSkillHubActionError(null);

      try {
        const result = await props.extensions.importCloudOrgSkillHub(hub);
        if (!result.ok) throw new Error(result.message);
        showToast({ title: `${result.message} ${t("den.reload_workspace")}`, tone: "success" });
      } catch (error) {
        setSkillHubActionError(error instanceof Error ? error.message : `Failed to import ${hub.name}.`);
      } finally {
        setSkillHubActionId(null);
        setSkillHubActionKind(null);
      }
    },
    [props.extensions, showToast, skillHubActionId],
  );

  const handleRemoveSkillHub = React.useCallback(
    async (hubId: string) => {
      const imported = props.extensions.importedCloudSkillHubs()[hubId];
      if (!imported || skillHubActionId) return;

      setSkillHubActionId(hubId);
      setSkillHubActionKind("remove");
      setSkillHubActionError(null);

      try {
        const result = await props.extensions.removeCloudOrgSkillHub(hubId);
        if (!result.ok) throw new Error(result.message);
        showToast({ title: `${result.message} ${t("den.reload_workspace")}`, tone: "success" });
      } catch (error) {
        setSkillHubActionError(error instanceof Error ? error.message : `Failed to remove ${imported.name}.`);
      } finally {
        setSkillHubActionId(null);
        setSkillHubActionKind(null);
      }
    },
    [props.extensions, showToast, skillHubActionId],
  );

  const handleSyncSkillHub = React.useCallback(
    async (hubId: string) => {
      const hub = props.extensions.cloudOrgSkillHubs().find((entry) => entry.id === hubId);
      if (!hub || skillHubActionId) return;

      setSkillHubActionId(hub.id);
      setSkillHubActionKind("sync");
      setSkillHubActionError(null);

      try {
        const result = await props.extensions.syncCloudOrgSkillHub(hub);
        if (!result.ok) throw new Error(result.message);
        showToast({ title: `${result.message} ${t("den.reload_workspace")}`, tone: "success" });
      } catch (error) {
        setSkillHubActionError(error instanceof Error ? error.message : `Failed to sync ${hub.name}.`);
      } finally {
        setSkillHubActionId(null);
        setSkillHubActionKind(null);
      }
    },
    [props.extensions, showToast, skillHubActionId],
  );

  // Skill mutations
  const handleImportSkill = React.useCallback(
    async (cloudSkillId: string, title: string) => {
      const skill = props.extensions.cloudOrgSkills().find((entry) => entry.id === cloudSkillId);
      if (!skill || skillActionId) return;

      setSkillActionId(cloudSkillId);
      setSkillActionKind("import");
      setSkillActionError(null);

      try {
        const result = await props.extensions.installCloudOrgSkill(skill);
        if (!result.ok) throw new Error(result.message);
        showToast({ title: `${result.message} ${t("den.reload_workspace")}`, tone: "success" });
      } catch (error) {
        setSkillActionError(
          error instanceof Error ? error.message : t("den.import_skill_failed", { name: title }),
        );
      } finally {
        setSkillActionId(null);
        setSkillActionKind(null);
      }
    },
    [props.extensions, showToast, skillActionId],
  );

  const handleRemoveSkill = React.useCallback(
    async (cloudSkillId: string, title: string) => {
      if (skillActionId) return;

      setSkillActionId(cloudSkillId);
      setSkillActionKind("remove");
      setSkillActionError(null);

      try {
        const result = await props.extensions.removeCloudOrgSkill(cloudSkillId);
        if (!result.ok) throw new Error(result.message);
        showToast({ title: `${result.message} ${t("den.reload_workspace")}`, tone: "success" });
      } catch (error) {
        setSkillActionError(
          error instanceof Error ? error.message : t("den.remove_skill_failed", { name: title }),
        );
      } finally {
        setSkillActionId(null);
        setSkillActionKind(null);
      }
    },
    [props.extensions, showToast, skillActionId],
  );

  const handleSyncSkill = React.useCallback(
    async (cloudSkillId: string, title: string) => {
      const skill = props.extensions.cloudOrgSkills().find((entry) => entry.id === cloudSkillId);
      if (!skill || skillActionId) return;

      setSkillActionId(cloudSkillId);
      setSkillActionKind("sync");
      setSkillActionError(null);

      try {
        const result = await props.extensions.syncCloudOrgSkill(skill);
        if (!result.ok) throw new Error(result.message);
        showToast({ title: `${result.message} ${t("den.reload_workspace")}`, tone: "success" });
      } catch (error) {
        setSkillActionError(
          error instanceof Error ? error.message : t("den.sync_skill_failed", { name: title }),
        );
      } finally {
        setSkillActionId(null);
        setSkillActionKind(null);
      }
    },
    [props.extensions, showToast, skillActionId],
  );

  // Marketplace plugin mutations
  const handleImportPlugin = React.useCallback(
    async (marketplaceId: string | null, plugin: DenOrgPlugin) => {
      if (pluginActionId) return;

      setPluginActionId(plugin.id);
      setPluginActionError(null);

      try {
        const result = await props.extensions.importCloudOrgPlugin(marketplaceId, plugin);
        if (!result.ok) throw new Error(result.message);
        showToast({ title: `${result.message} ${t("den.reload_workspace")}`, tone: "success" });
      } catch (error) {
        setPluginActionError(error instanceof Error ? error.message : `Failed to import ${plugin.name}.`);
      } finally {
        setPluginActionId(null);
      }
    },
    [pluginActionId, props.extensions, showToast],
  );

  // Provider mutations
  const handleImportProvider = React.useCallback(
    async (cloudProviderId: string, providerName: string) => {
      if (providerActionId) return;

      setProviderActionId(cloudProviderId);
      setProviderActionKind("import");
      setProviderActionError(null);

      try {
        const message = await props.connectCloudProvider(cloudProviderId);
        showToast({
          title: `${message || t("den.imported_provider", { name: providerName })} ${t("den.reload_workspace")}`,
          tone: "success",
        });
      } catch (error) {
        setProviderActionError(
          error instanceof Error ? error.message : t("den.import_provider_failed", { name: providerName }),
        );
      } finally {
        setProviderActionId(null);
        setProviderActionKind(null);
      }
    },
    [props, providerActionId, showToast],
  );

  const handleRemoveProvider = React.useCallback(
    async (cloudProviderId: string, providerName: string) => {
      if (providerActionId) return;

      setProviderActionId(cloudProviderId);
      setProviderActionKind("remove");
      setProviderActionError(null);

      try {
        const message = await props.removeCloudProvider(cloudProviderId);
        showToast({
          title: `${message || t("den.removed_provider", { name: providerName })} ${t("den.reload_workspace")}`,
          tone: "success",
        });
      } catch (error) {
        setProviderActionError(
          error instanceof Error ? error.message : t("den.remove_provider_failed", { name: providerName }),
        );
      } finally {
        setProviderActionId(null);
        setProviderActionKind(null);
      }
    },
    [props, providerActionId, showToast],
  );

  const handleSyncProvider = React.useCallback(
    async (cloudProviderId: string, providerName: string) => {
      if (providerActionId) return;

      setProviderActionId(cloudProviderId);
      setProviderActionKind("sync");
      setProviderActionError(null);

      try {
        await props.connectCloudProvider(cloudProviderId);
        showToast({
          title: `${t("den.synced_provider", { name: providerName })} ${t("den.reload_workspace")}`,
          tone: "success",
        });
      } catch (error) {
        setProviderActionError(
          error instanceof Error ? error.message : t("den.sync_provider_failed", { name: providerName }),
        );
      } finally {
        setProviderActionId(null);
        setProviderActionKind(null);
      }
    },
    [props, providerActionId, showToast],
  );

  return (
    <SettingsStack>
      <Separator />

      <SettingsSection>
        <SettingsSectionHeader>
          <SettingsSectionHeaderContent>
            <SettingsSectionHeaderTitle>{t("den.cloud_section_title")}

            <SettingsStatusBadge tone={summaryTone} label={summaryLabel} />

            </SettingsSectionHeaderTitle>
            <SettingsSectionHeaderDescription className="">
              {t(isSignedIn ? "den.cloud_signed_in_desc" : "den.cloud_section_desc")}
            </SettingsSectionHeaderDescription>
            {!isSignedIn ? (
              <SettingsSectionHeaderDescription className="text-xs">
                {t("den.cloud_sleep_hint")}
              </SettingsSectionHeaderDescription>
            ) : null}
          </SettingsSectionHeaderContent>
        </SettingsSectionHeader>

        {props.developerMode ? (
          <CloudDevMode
            authBusy={authBusy}
            baseUrlDraft={baseUrlDraft}
            onApplyBaseUrl={applyBaseUrl}
            onBaseUrlDraftChange={setBaseUrlDraft}
            onOpenControlPlane={openControlPlane}
            onResetBaseUrl={() => setBaseUrlDraft(baseUrl)}
            sessionBusy={sessionBusy}
          />
        ) : null}

        {baseUrlError ? <SettingsNotice tone="error">{baseUrlError}</SettingsNotice> : null}

        {statusMessage && !authError && !workersError && !orgsError && !pluginActionError ? (
          <SettingsNotice>{statusMessage}</SettingsNotice>
        ) : null}

        {isSignedIn ? (
          <>
            <CloudAccountSection
              activeOrgId={activeOrgId}
              authBusy={authBusy}
              orgs={orgs}
              orgsBusy={orgsBusy}
              orgsError={orgsError}
              sessionBusy={sessionBusy}
              user={user}
              onActiveOrgChange={handleActiveOrgChange}
              onRefreshOrgs={refreshOrgs}
              onSignOut={signOut}
            />
          </>
        ) : null}
      </SettingsSection>

      <Separator />


      {!isSignedIn ? (
        <DenSignedOutPanel
          authBusy={authBusy}
          authError={authError}
          onClearAuthError={() => setAuthError(null)}
          onOpenBrowserAuth={openBrowserAuth}
          onSubmitManualAuth={submitManualAuth}
          sessionBusy={sessionBusy}
        />
      ) : (
        <div className="flex flex-col gap-y-8">
          <CloudSkillsSection
            actionError={skillActionError}
            actionId={skillActionId}
            actionKind={skillActionKind}
            activeOrgName={activeOrgName}
            busy={skillsBusy}
            hasActiveOrg={Boolean(activeOrgId.trim())}
            rows={skillRows}
            statusError={props.extensions.cloudOrgSkillsStatus()}
            onImportSkill={handleImportSkill}
            onRefresh={refreshSkills}
            onRemoveSkill={handleRemoveSkill}
            onSyncSkill={handleSyncSkill}
          />

          <Separator />

          <MarketplacePluginsSection
            actionError={pluginActionError}
            actionId={pluginActionId}
            activeMarketplaceId={activeMarketplaceId}
            activeOrgName={activeOrgName}
            busy={marketplacesBusy}
            hasActiveOrg={Boolean(activeOrgId.trim())}
            marketplaces={liveMarketplaces}
            rowsByMarketplace={marketplacePluginRows}
            statusError={props.extensions.cloudOrgMarketplacesStatus()}
            onImportPlugin={handleImportPlugin}
            onRefresh={refreshMarketplaces}
            onSelectMarketplace={setActiveMarketplaceId}
          />

          <Separator />

          <CloudWorkersSection
            activeOrgName={activeOrgName}
            openingWorkerId={openingWorkerId}
            refreshDisabled={[workersBusy, !activeOrgId.trim()].some(Boolean)}
            workers={workers}
            workersBusy={workersBusy}
            workersError={workersError}
            onOpenWorker={handleOpenWorker}
            onRefreshWorkers={refreshWorkers}
          />

          <Separator />

          <SkillHubsSection
            actionError={skillHubActionError}
            actionId={skillHubActionId}
            actionKind={skillHubActionKind}
            activeOrgName={activeOrgName}
            busy={skillHubsBusy}
            hasActiveOrg={Boolean(activeOrgId.trim())}
            rows={skillHubRows}
            statusError={props.extensions.cloudOrgSkillHubsStatus()}
            onImport={handleImportSkillHub}
            onRefresh={refreshSkillHubs}
            onRemove={handleRemoveSkillHub}
            onSync={handleSyncSkillHub}
          />

          <Separator />

          <CloudProvidersSection
            actionError={providerActionError}
            actionId={providerActionId}
            actionKind={providerActionKind}
            activeOrgName={activeOrgName}
            busy={providersBusy}
            hasActiveOrg={Boolean(activeOrgId.trim())}
            rows={providerRows}
            onImport={handleImportProvider}
            onRefresh={refreshProviders}
            onRemove={handleRemoveProvider}
            onSync={handleSyncProvider}
          />
        </div>
      )}
    </SettingsStack>
  );
}

export default DenSettingsPanel;
