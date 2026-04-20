/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  Boxes,
  Brain,
  Cloud,
  KeyRound,
  LogOut,
  Package,
  RefreshCcw,
  Server,
  Users,
} from "lucide-react";

import { currentLocale, t } from "../../../../i18n";
import {
  buildDenAuthUrl,
  clearDenSession,
  DEFAULT_DEN_BASE_URL,
  DenApiError,
  type DenOrgLlmProvider,
  type DenOrgSkillHub,
  type DenTemplate,
  type DenUser,
  createDenClient,
  ensureDenActiveOrganization,
  normalizeDenBaseUrl,
  readDenSettings,
  resolveDenBaseUrls,
  writeDenSettings,
} from "../../../../app/lib/den";
import {
  clearDenTemplateCache,
  loadDenTemplateCache,
  readDenTemplateCacheSnapshot,
} from "../../../../app/lib/den-template-cache";
import {
  denSessionUpdatedEvent,
  dispatchDenSessionUpdated,
  type DenSessionUpdatedDetail,
} from "../../../../app/lib/den-session-events";
import type { CloudImportedProvider, CloudImportedSkill, CloudImportedSkillHub } from "../../../../app/cloud/import-state";
import type { DenOrgSkillCard, SkillCard } from "../../../../app/types";
import { Button } from "../../../design-system/button";
import { TextInput } from "../../../design-system/text-input";

type CloudSkillHubRow = {
  key: string;
  hubId: string;
  name: string;
  hub: DenOrgSkillHub | null;
  imported: CloudImportedSkillHub | null;
  status: "available" | "imported" | "out_of_sync" | "removed_from_cloud";
  liveSkillCount: number;
  importedSkillCount: number;
};

type CloudProviderRow = {
  key: string;
  cloudProviderId: string;
  provider: DenOrgLlmProvider | null;
  imported: CloudImportedProvider | null;
  status: "available" | "imported" | "out_of_sync" | "removed_from_cloud";
  name: string;
};

type CloudSkillRow = {
  key: string;
  cloudSkillId: string;
  skill: DenOrgSkillCard | null;
  imported: CloudImportedSkill | null;
  status: "available" | "installed" | "out_of_sync" | "removed_from_cloud";
  title: string;
  installedName: string | null;
};

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
  openTeamBundle: (input: {
    templateId: string;
    name: string;
    templateData: unknown;
    organizationName?: string | null;
  }) => void | Promise<void>;
  cloudOrgProviders: DenOrgLlmProvider[];
  importedCloudProviders: Record<string, CloudImportedProvider>;
  refreshCloudOrgProviders: (options?: { force?: boolean }) => Promise<DenOrgLlmProvider[]>;
  connectCloudProvider: (cloudProviderId: string) => Promise<string | void>;
  removeCloudProvider: (cloudProviderId: string) => Promise<string | void>;
};

const settingsPanelClass = "ow-soft-card rounded-[28px] p-5 md:p-6";
const settingsPanelSoftClass = "ow-soft-card-quiet rounded-2xl p-4";
const headerBadgeClass =
  "inline-flex min-h-8 items-center gap-2 rounded-xl border border-dls-border bg-dls-hover px-3 text-[13px] font-medium text-dls-text shadow-sm";
const headerStatusBadgeClass =
  "inline-flex min-h-10 min-w-[132px] items-center justify-center gap-2 rounded-2xl border border-dls-border bg-dls-hover px-4 text-center text-sm font-medium text-dls-text shadow-sm";
const sectionPillClass =
  "inline-flex items-center gap-1.5 rounded-full border border-dls-border bg-dls-hover px-2.5 py-1 text-[11px] font-medium text-dls-secondary";
const softNoticeClass =
  "rounded-xl border border-dls-border bg-dls-hover px-3 py-2 text-xs text-dls-secondary";
const quietControlClass =
  "border border-dls-border bg-dls-hover text-dls-text shadow-sm";
const errorBannerClass =
  "rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11";

const sortStrings = (values: string[]) => [...values].sort();

const sameStringList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

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

function workerStatusMeta(status: string, tr: (key: string) => string) {
  const normalized = status.trim().toLowerCase();
  switch (normalized) {
    case "healthy":
      return { label: tr("dashboard.worker_status_ready"), tone: "ready" as const, canOpen: true };
    case "provisioning":
      return { label: tr("dashboard.worker_status_starting"), tone: "warning" as const, canOpen: false };
    case "failed":
      return { label: tr("dashboard.worker_status_attention"), tone: "error" as const, canOpen: false };
    case "stopped":
      return { label: tr("dashboard.worker_status_stopped"), tone: "neutral" as const, canOpen: false };
    default:
      return {
        label: normalized
          ? `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`
          : tr("dashboard.worker_status_unknown"),
        tone: "neutral" as const,
        canOpen: normalized === "ready",
      };
  }
}

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

function formatTemplateTimestamp(value: string | null, tr: (key: string) => string) {
  if (!value) return tr("dashboard.recently_updated");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return tr("dashboard.recently_updated");
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function templateCreatorLabel(template: DenTemplate, tr: (key: string) => string) {
  const creator = template.creator;
  if (!creator) return tr("dashboard.unknown_creator");
  return creator.name?.trim() || creator.email?.trim() || tr("dashboard.unknown_creator");
}

export function DenSettingsPanel(props: DenSettingsPanelProps) {
  const tr = useCallback((key: string) => t(key, currentLocale()), []);
  const tx = useCallback(
    (key: string, params?: Record<string, string | number>) =>
      t(key, currentLocale(), params),
    [],
  );

  const initial = useMemo(() => readDenSettings(), []);
  const initialBaseUrl = initial.baseUrl || DEFAULT_DEN_BASE_URL;
  const initialTemplateSnapshot = useMemo(
    () =>
      readDenTemplateCacheSnapshot({
        baseUrl: initialBaseUrl,
        token: initial.authToken?.trim() || "",
        orgSlug: initial.activeOrgSlug?.trim() || null,
      }),
    [initial.activeOrgSlug, initial.authToken, initialBaseUrl],
  );

  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [baseUrlDraft, setBaseUrlDraft] = useState(initialBaseUrl);
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState(initial.authToken?.trim() || "");
  const [activeOrgId, setActiveOrgId] = useState(initial.activeOrgId?.trim() || "");
  const [authBusy, setAuthBusy] = useState(false);
  const [manualAuthOpen, setManualAuthOpen] = useState(false);
  const [manualAuthInput, setManualAuthInput] = useState("");
  const [sessionBusy, setSessionBusy] = useState(false);
  const [orgsBusy, setOrgsBusy] = useState(false);
  const [workersBusy, setWorkersBusy] = useState(false);
  const [openingWorkerId, setOpeningWorkerId] = useState<string | null>(null);
  const [openingTemplateId, setOpeningTemplateId] = useState<string | null>(null);
  const [user, setUser] = useState<DenUser | null>(null);
  const [orgs, setOrgs] = useState<
    Array<{ id: string; name: string; slug: string; role: "owner" | "admin" | "member" }>
  >([]);
  const [workers, setWorkers] = useState<
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
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [orgsError, setOrgsError] = useState<string | null>(null);
  const [workersError, setWorkersError] = useState<string | null>(null);
  const [templatesBusy, setTemplatesBusy] = useState(initialTemplateSnapshot.busy);
  const [templates, setTemplates] = useState(initialTemplateSnapshot.templates);
  const [templateError, setTemplateError] = useState<string | null>(initialTemplateSnapshot.error);
  const [skillHubsBusy, setSkillHubsBusy] = useState(false);
  const [skillHubActionId, setSkillHubActionId] = useState<string | null>(null);
  const [skillHubActionKind, setSkillHubActionKind] = useState<"import" | "remove" | "sync" | null>(null);
  const [skillHubActionError, setSkillHubActionError] = useState<string | null>(null);
  const [skillsBusy, setSkillsBusy] = useState(false);
  const [skillActionId, setSkillActionId] = useState<string | null>(null);
  const [skillActionKind, setSkillActionKind] = useState<"import" | "remove" | "sync" | null>(null);
  const [skillActionError, setSkillActionError] = useState<string | null>(null);
  const [providersBusy, setProvidersBusy] = useState(false);
  const [providerActionId, setProviderActionId] = useState<string | null>(null);
  const [providerActionKind, setProviderActionKind] = useState<"import" | "remove" | "sync" | null>(null);
  const [providerActionError, setProviderActionError] = useState<string | null>(null);

  const activeOrg = useMemo(
    () => orgs.find((org) => org.id === activeOrgId) ?? null,
    [activeOrgId, orgs],
  );
  const isSignedIn = Boolean(user && authToken.trim());
  const activeOrgName = activeOrg?.name || tr("den.no_org_selected");

  const client = useMemo(
    () => createDenClient({ baseUrl, token: authToken }),
    [authToken, baseUrl],
  );

  const installedSkillNames = useMemo(
    () => new Set(props.extensions.skills().map((skill) => skill.name)),
    [props.extensions],
  );

  const skillHubImports = props.extensions.importedCloudSkillHubs();
  const liveSkillHubs = props.extensions.cloudOrgSkillHubs();
  const liveSkills = props.extensions.cloudOrgSkills();
  const importedSkills = props.extensions.importedCloudSkills();

  const skillHubRows = useMemo<CloudSkillHubRow[]>(() => {
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

  const skillRows = useMemo<CloudSkillRow[]>(() => {
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

  const providerRows = useMemo<CloudProviderRow[]>(() => {
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

  const summaryTone = useMemo(() => {
    if (
      authError ||
      workersError ||
      orgsError ||
      templateError ||
      skillActionError ||
      providerActionError ||
      skillHubActionError
    ) {
      return "error" as const;
    }
    if (
      sessionBusy ||
      orgsBusy ||
      workersBusy ||
      templatesBusy ||
      skillsBusy ||
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
    providerActionError,
    providersBusy,
    sessionBusy,
    skillActionError,
    skillHubActionError,
    skillHubsBusy,
    skillsBusy,
    templateError,
    templatesBusy,
    workersBusy,
    workersError,
  ]);

  const summaryLabel = useMemo(() => {
    if (authError) return tr("den.needs_attention");
    if (sessionBusy) return tr("den.checking_session");
    if (isSignedIn) return tr("dashboard.connected");
    return tr("den.signed_out");
  }, [authError, isSignedIn, sessionBusy, tr]);

  const clearSessionState = useCallback(() => {
    setUser(null);
    setOrgs([]);
    setWorkers([]);
    setActiveOrgId("");
    setOrgsError(null);
    setWorkersError(null);
    setTemplateError(null);
    setTemplates([]);
    setSkillHubActionError(null);
    setProviderActionError(null);
    setSkillHubActionKind(null);
    setProviderActionKind(null);
  }, []);

  const clearSignedInState = useCallback(
    (message?: string | null) => {
      clearDenSession({ includeBaseUrls: !props.developerMode });
      clearDenTemplateCache();
      if (!props.developerMode) {
        setBaseUrl(DEFAULT_DEN_BASE_URL);
        setBaseUrlDraft(DEFAULT_DEN_BASE_URL);
      }
      setAuthToken("");
      setOpeningWorkerId(null);
      setOpeningTemplateId(null);
      setTemplatesBusy(false);
      setSkillHubActionId(null);
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

  useEffect(() => {
    writeDenSettings({
      baseUrl,
      authToken: authToken || null,
      activeOrgId: activeOrgId || null,
      activeOrgSlug: activeOrg?.slug ?? null,
      activeOrgName: activeOrg?.name ?? null,
    });
  }, [activeOrg, activeOrgId, authToken, baseUrl]);

  const openControlPlane = useCallback(() => {
    props.openLink(resolveDenBaseUrls(baseUrl).baseUrl);
  }, [baseUrl, props]);

  const openBrowserAuth = useCallback(
    (mode: "sign-in" | "sign-up") => {
      props.openLink(buildDenAuthUrl(baseUrl, mode));
      setStatusMessage(
        mode === "sign-up"
          ? tr("den.status_browser_signup")
          : tr("den.status_browser_signin"),
      );
      setAuthError(null);
    },
    [baseUrl, props, tr],
  );

  const applyBaseUrl = useCallback(() => {
    const normalized = normalizeDenBaseUrl(baseUrlDraft);
    if (!normalized) {
      setBaseUrlError(tr("den.error_base_url"));
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
    clearSignedInState(tr("den.status_base_url_updated"));
  }, [baseUrl, baseUrlDraft, clearSignedInState, tr]);

  const refreshOrgs = useCallback(
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
          setStatusMessage(
            tx("den.status_loaded_orgs", {
              count: response.orgs.length,
              plural: response.orgs.length === 1 ? "" : "s",
            }),
          );
        }
      } catch (error) {
        setOrgsError(error instanceof Error ? error.message : tr("den.error_load_orgs"));
      } finally {
        setOrgsBusy(false);
      }
    },
    [activeOrgId, authToken, baseUrl, client, tr, tx],
  );

  const refreshWorkers = useCallback(
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
          setStatusMessage(
            nextWorkers.length > 0
              ? tx("den.status_loaded_workers", {
                  count: nextWorkers.length,
                  plural: nextWorkers.length === 1 ? "" : "s",
                  name: activeOrg?.name ?? tr("den.active_org_title"),
                })
              : tx("den.status_no_workers", {
                  name: activeOrg?.name ?? tr("den.active_org_title"),
                }),
          );
        }
      } catch (error) {
        setWorkersError(error instanceof Error ? error.message : tr("den.error_load_workers"));
      } finally {
        setWorkersBusy(false);
      }
    },
    [activeOrg, activeOrgId, authToken, client, tr, tx],
  );

  const refreshTemplates = useCallback(
    async (quiet = false) => {
      const orgSlug = activeOrg?.slug?.trim() ?? "";
      if (!authToken.trim() || !orgSlug) return;

      setTemplatesBusy(true);
      setTemplateError(null);

      try {
        const nextTemplates = await loadDenTemplateCache(
          {
            baseUrl,
            token: authToken,
            orgSlug,
          },
          { force: true },
        );
        setTemplates(nextTemplates);
        if (!quiet) {
          setStatusMessage(
            nextTemplates.length > 0
              ? tx("den.status_loaded_templates", {
                  count: nextTemplates.length,
                  plural: nextTemplates.length === 1 ? "" : "s",
                  name: activeOrg?.name ?? tr("den.active_org_title"),
                })
              : tx("den.status_no_templates", {
                  name: activeOrg?.name ?? tr("den.active_org_title"),
                }),
          );
        }
      } catch (error) {
        if (!quiet) {
          setTemplateError(error instanceof Error ? error.message : tr("den.error_load_templates"));
        }
      } finally {
        setTemplatesBusy(false);
      }
    },
    [activeOrg, authToken, baseUrl, tr, tx],
  );

  const refreshSkillHubs = useCallback(
    async (quiet = false) => {
      const orgId = activeOrgId.trim();
      if (!authToken.trim() || !orgId) return;

      setSkillHubsBusy(true);
      if (!quiet) setSkillHubActionError(null);

      try {
        await props.extensions.refreshCloudOrgSkillHubs({ force: true });
        if (!quiet) {
          const count = props.extensions.cloudOrgSkillHubs().length;
          setStatusMessage(
            count > 0
              ? `Loaded ${count} cloud skill hub${count === 1 ? "" : "s"} for ${activeOrg?.name ?? tr("den.active_org_title")}.`
              : `No cloud skill hubs are available for ${activeOrg?.name ?? tr("den.active_org_title")}.`,
          );
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
    [activeOrg, activeOrgId, authToken, props.extensions, tr],
  );

  const refreshSkills = useCallback(
    async (quiet = false) => {
      const orgId = activeOrgId.trim();
      if (!authToken.trim() || !orgId) return;

      setSkillsBusy(true);
      if (!quiet) setSkillActionError(null);

      try {
        await props.extensions.refreshCloudOrgSkills({ force: true });
        if (!quiet) {
          const count = props.extensions.cloudOrgSkills().length;
          setStatusMessage(
            count > 0
              ? tx("den.status_loaded_skills", {
                  count,
                  plural: count === 1 ? "" : "s",
                  name: activeOrg?.name ?? tr("den.active_org_title"),
                })
              : tx("den.status_no_skills", {
                  name: activeOrg?.name ?? tr("den.active_org_title"),
                }),
          );
        }
      } catch (error) {
        if (!quiet) {
          setSkillActionError(error instanceof Error ? error.message : tr("den.error_load_skills"));
        }
      } finally {
        setSkillsBusy(false);
      }
    },
    [activeOrg, activeOrgId, authToken, props.extensions, tr, tx],
  );

  const refreshProviders = useCallback(
    async (quiet = false) => {
      const orgId = activeOrgId.trim();
      if (!authToken.trim() || !orgId) return;

      setProvidersBusy(true);
      setProviderActionError(null);

      try {
        const items = await props.refreshCloudOrgProviders({ force: !quiet });
        if (!quiet) {
          setStatusMessage(
            items.length > 0
              ? `Loaded ${items.length} cloud provider${items.length === 1 ? "" : "s"} for ${activeOrg?.name ?? tr("den.active_org_title")}.`
              : `No cloud providers are available for ${activeOrg?.name ?? tr("den.active_org_title")}.`,
          );
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
    [activeOrg, activeOrgId, authToken, props, tr],
  );

  useEffect(() => {
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
        setStatusMessage(tx("den.status_signed_in_as", { email: nextUser.email }));
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof DenApiError && error.status === 401) {
          clearSignedInState();
        } else {
          clearSessionState();
        }
        setAuthError(error instanceof Error ? error.message : tr("den.error_no_session"));
      })
      .finally(() => {
        if (!cancelled) setSessionBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authToken, baseUrl, clearSessionState, clearSignedInState, tr, tx]);

  useEffect(() => {
    if (!user) return;
    void refreshOrgs(true);
  }, [refreshOrgs, user]);

  useEffect(() => {
    if (!user || !activeOrgId.trim()) return;
    void refreshWorkers(true);
  }, [activeOrgId, refreshWorkers, user]);

  useEffect(() => {
    if (!user || !activeOrg?.slug?.trim()) return;
    void refreshTemplates(true);
  }, [activeOrg, refreshTemplates, user]);

  useEffect(() => {
    if (!user || !activeOrgId.trim()) return;
    void refreshSkillHubs(true);
  }, [activeOrgId, refreshSkillHubs, user]);

  useEffect(() => {
    if (!user || !activeOrgId.trim()) return;
    void refreshSkills(true);
  }, [activeOrgId, refreshSkills, user]);

  useEffect(() => {
    if (!user || !activeOrgId.trim()) return;
    void refreshProviders(true);
  }, [activeOrgId, refreshProviders, user]);

  useEffect(() => {
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
            ? tx("den.status_cloud_signed_in_as", { email: customEvent.detail.email.trim() })
            : tr("den.status_cloud_signin_done"),
        );
      } else if (customEvent.detail?.status === "error") {
        setAuthError(customEvent.detail.message?.trim() || tr("den.error_signin_failed"));
      }
    };

    window.addEventListener(denSessionUpdatedEvent, handler as EventListener);
    return () => window.removeEventListener(denSessionUpdatedEvent, handler as EventListener);
  }, [clearSessionState, tr, tx]);

  const submitManualAuth = useCallback(async () => {
    const parsed = parseManualAuthInput(manualAuthInput);
    if (!parsed || authBusy) {
      if (!parsed) setAuthError(tr("den.error_paste_valid_code"));
      return;
    }

    const nextBaseUrl = parsed.baseUrl ?? baseUrl;
    setAuthBusy(true);
    setAuthError(null);
    setStatusMessage(tr("den.signing_in"));

    try {
      const result = await createDenClient({ baseUrl: nextBaseUrl }).exchangeDesktopHandoff(parsed.grant);
      if (!result.token) {
        throw new Error(tr("den.error_no_token"));
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
        message: error instanceof Error ? error.message : tr("den.error_signin_failed"),
      });
    } finally {
      setAuthBusy(false);
    }
  }, [authBusy, baseUrl, manualAuthInput, props.developerMode, tr]);

  const signOut = useCallback(async () => {
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

    clearSignedInState(tr("den.status_signed_out"));
  }, [authBusy, authToken, clearSignedInState, client, tr]);

  const handleOpenWorker = useCallback(
    async (workerId: string, workerName: string) => {
      const orgId = activeOrgId.trim();
      if (!orgId) {
        setWorkersError(tr("den.error_choose_org"));
        return;
      }

      setOpeningWorkerId(workerId);
      setWorkersError(null);

      try {
        const tokens = await client.getWorkerTokens(workerId, orgId);
        const openworkUrl = tokens.openworkUrl?.trim() ?? "";
        const accessToken = tokens.ownerToken?.trim() || tokens.clientToken?.trim() || "";
        if (!openworkUrl || !accessToken) {
          throw new Error(tr("den.error_worker_not_ready"));
        }

        const ok = await props.connectRemoteWorkspace({
          openworkHostUrl: openworkUrl,
          openworkToken: accessToken,
          directory: null,
          displayName: workerName,
        });
        if (!ok) {
          throw new Error(tx("den.error_open_worker", { name: workerName }));
        }

        setStatusMessage(tx("den.status_opened_worker", { name: workerName }));
      } catch (error) {
        setWorkersError(
          error instanceof Error
            ? error.message
            : tx("den.error_open_worker_fallback", { name: workerName }),
        );
      } finally {
        setOpeningWorkerId(null);
      }
    },
    [activeOrgId, client, props, tr, tx],
  );

  const handleOpenTemplate = useCallback(
    async (template: DenTemplate) => {
      if (openingTemplateId) return;

      setOpeningTemplateId(template.id);
      setTemplateError(null);

      try {
        await props.openTeamBundle({
          templateId: template.id,
          name: template.name,
          templateData: template.templateData,
          organizationName: activeOrg?.name ?? null,
        });
        const orgName = activeOrg?.name;
        setStatusMessage(
          orgName
            ? tx("den.status_opened_template", { name: template.name, org: orgName })
            : tx("den.status_opened_template_fallback", { name: template.name }),
        );
      } catch (error) {
        setTemplateError(
          error instanceof Error ? error.message : tx("den.error_open_template", { name: template.name }),
        );
      } finally {
        setOpeningTemplateId(null);
      }
    },
    [activeOrg, openingTemplateId, props, tx],
  );

  const handleImportSkillHub = useCallback(
    async (hubId: string) => {
      const hub = props.extensions.cloudOrgSkillHubs().find((entry) => entry.id === hubId);
      if (!hub || skillHubActionId) return;

      setSkillHubActionId(hub.id);
      setSkillHubActionKind("import");
      setSkillHubActionError(null);

      try {
        const result = await props.extensions.importCloudOrgSkillHub(hub);
        if (!result.ok) throw new Error(result.message);
        setStatusMessage(`${result.message} ${tr("den.reload_workspace")}`);
      } catch (error) {
        setSkillHubActionError(error instanceof Error ? error.message : `Failed to import ${hub.name}.`);
      } finally {
        setSkillHubActionId(null);
        setSkillHubActionKind(null);
      }
    },
    [props.extensions, skillHubActionId, tr],
  );

  const handleRemoveSkillHub = useCallback(
    async (hubId: string) => {
      const imported = props.extensions.importedCloudSkillHubs()[hubId];
      if (!imported || skillHubActionId) return;

      setSkillHubActionId(hubId);
      setSkillHubActionKind("remove");
      setSkillHubActionError(null);

      try {
        const result = await props.extensions.removeCloudOrgSkillHub(hubId);
        if (!result.ok) throw new Error(result.message);
        setStatusMessage(`${result.message} ${tr("den.reload_workspace")}`);
      } catch (error) {
        setSkillHubActionError(error instanceof Error ? error.message : `Failed to remove ${imported.name}.`);
      } finally {
        setSkillHubActionId(null);
        setSkillHubActionKind(null);
      }
    },
    [props.extensions, skillHubActionId, tr],
  );

  const handleSyncSkillHub = useCallback(
    async (hubId: string) => {
      const hub = props.extensions.cloudOrgSkillHubs().find((entry) => entry.id === hubId);
      if (!hub || skillHubActionId) return;

      setSkillHubActionId(hub.id);
      setSkillHubActionKind("sync");
      setSkillHubActionError(null);

      try {
        const result = await props.extensions.syncCloudOrgSkillHub(hub);
        if (!result.ok) throw new Error(result.message);
        setStatusMessage(`${result.message} ${tr("den.reload_workspace")}`);
      } catch (error) {
        setSkillHubActionError(error instanceof Error ? error.message : `Failed to sync ${hub.name}.`);
      } finally {
        setSkillHubActionId(null);
        setSkillHubActionKind(null);
      }
    },
    [props.extensions, skillHubActionId, tr],
  );

  const handleImportSkill = useCallback(
    async (cloudSkillId: string, title: string) => {
      const skill = props.extensions.cloudOrgSkills().find((entry) => entry.id === cloudSkillId);
      if (!skill || skillActionId) return;

      setSkillActionId(cloudSkillId);
      setSkillActionKind("import");
      setSkillActionError(null);

      try {
        const result = await props.extensions.installCloudOrgSkill(skill);
        if (!result.ok) throw new Error(result.message);
        setStatusMessage(`${result.message} ${tr("den.reload_workspace")}`);
      } catch (error) {
        setSkillActionError(
          error instanceof Error ? error.message : tx("den.import_skill_failed", { name: title }),
        );
      } finally {
        setSkillActionId(null);
        setSkillActionKind(null);
      }
    },
    [props.extensions, skillActionId, tr, tx],
  );

  const handleRemoveSkill = useCallback(
    async (cloudSkillId: string, title: string) => {
      if (skillActionId) return;

      setSkillActionId(cloudSkillId);
      setSkillActionKind("remove");
      setSkillActionError(null);

      try {
        const result = await props.extensions.removeCloudOrgSkill(cloudSkillId);
        if (!result.ok) throw new Error(result.message);
        setStatusMessage(`${result.message} ${tr("den.reload_workspace")}`);
      } catch (error) {
        setSkillActionError(
          error instanceof Error ? error.message : tx("den.remove_skill_failed", { name: title }),
        );
      } finally {
        setSkillActionId(null);
        setSkillActionKind(null);
      }
    },
    [props.extensions, skillActionId, tr, tx],
  );

  const handleSyncSkill = useCallback(
    async (cloudSkillId: string, title: string) => {
      const skill = props.extensions.cloudOrgSkills().find((entry) => entry.id === cloudSkillId);
      if (!skill || skillActionId) return;

      setSkillActionId(cloudSkillId);
      setSkillActionKind("sync");
      setSkillActionError(null);

      try {
        const result = await props.extensions.syncCloudOrgSkill(skill);
        if (!result.ok) throw new Error(result.message);
        setStatusMessage(`${result.message} ${tr("den.reload_workspace")}`);
      } catch (error) {
        setSkillActionError(
          error instanceof Error ? error.message : tx("den.sync_skill_failed", { name: title }),
        );
      } finally {
        setSkillActionId(null);
        setSkillActionKind(null);
      }
    },
    [props.extensions, skillActionId, tr, tx],
  );

  const handleImportProvider = useCallback(
    async (cloudProviderId: string, providerName: string) => {
      if (providerActionId) return;

      setProviderActionId(cloudProviderId);
      setProviderActionKind("import");
      setProviderActionError(null);

      try {
        const message = await props.connectCloudProvider(cloudProviderId);
        setStatusMessage(`${message || tx("den.imported_provider", { name: providerName })} ${tr("den.reload_workspace")}`);
      } catch (error) {
        setProviderActionError(
          error instanceof Error ? error.message : tx("den.import_provider_failed", { name: providerName }),
        );
      } finally {
        setProviderActionId(null);
        setProviderActionKind(null);
      }
    },
    [props, providerActionId, tr, tx],
  );

  const handleRemoveProvider = useCallback(
    async (cloudProviderId: string, providerName: string) => {
      if (providerActionId) return;

      setProviderActionId(cloudProviderId);
      setProviderActionKind("remove");
      setProviderActionError(null);

      try {
        const message = await props.removeCloudProvider(cloudProviderId);
        setStatusMessage(`${message || tx("den.removed_provider", { name: providerName })} ${tr("den.reload_workspace")}`);
      } catch (error) {
        setProviderActionError(
          error instanceof Error ? error.message : tx("den.remove_provider_failed", { name: providerName }),
        );
      } finally {
        setProviderActionId(null);
        setProviderActionKind(null);
      }
    },
    [props, providerActionId, tr, tx],
  );

  const handleSyncProvider = useCallback(
    async (cloudProviderId: string, providerName: string) => {
      if (providerActionId) return;

      setProviderActionId(cloudProviderId);
      setProviderActionKind("sync");
      setProviderActionError(null);

      try {
        await props.connectCloudProvider(cloudProviderId);
        setStatusMessage(`${tx("den.synced_provider", { name: providerName })} ${tr("den.reload_workspace")}`);
      } catch (error) {
        setProviderActionError(
          error instanceof Error ? error.message : tx("den.sync_provider_failed", { name: providerName }),
        );
      } finally {
        setProviderActionId(null);
        setProviderActionKind(null);
      }
    },
    [props, providerActionId, tr, tx],
  );

  return (
    <div className="space-y-6">
      <div className={`${settingsPanelClass} space-y-4`}>
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-2">
            <div className={headerBadgeClass}>
              <Cloud size={13} className="text-dls-secondary" />
              {tr("den.cloud_section_title")}
            </div>
            <div>
              <div className="text-sm font-medium text-dls-text">
                {tr("den.cloud_section_desc")}
              </div>
              <div className="mt-1 max-w-[60ch] text-xs text-dls-secondary">
                {tr("den.cloud_sleep_hint")}
              </div>
            </div>
          </div>
          <div className={headerStatusBadgeClass}>
            <span
              className={`h-2 w-2 rounded-full ${
                summaryTone === "ready"
                  ? "bg-green-500"
                  : summaryTone === "warning"
                    ? "bg-amber-500"
                    : summaryTone === "error"
                      ? "bg-red-500"
                      : "bg-gray-400"
              }`}
            />
            {summaryLabel}
          </div>
        </div>

        {props.developerMode ? (
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <TextInput
              label={tr("den.cloud_control_plane_url_label")}
              value={baseUrlDraft}
              onChange={(event) => setBaseUrlDraft(event.currentTarget.value)}
              placeholder={DEFAULT_DEN_BASE_URL}
              hint={tr("den.cloud_control_plane_url_hint")}
              disabled={authBusy || sessionBusy}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                className="h-9 px-3 text-xs"
                onClick={() => setBaseUrlDraft(baseUrl)}
                disabled={authBusy || sessionBusy}
              >
                {tr("den.cloud_control_plane_reset")}
              </Button>
              <Button
                variant="secondary"
                className="h-9 px-3 text-xs"
                onClick={applyBaseUrl}
                disabled={authBusy || sessionBusy}
              >
                {tr("den.cloud_control_plane_save")}
              </Button>
              <Button variant="outline" className="h-9 px-3 text-xs" onClick={openControlPlane}>
                {tr("den.cloud_control_plane_open")}
                <ArrowUpRight size={13} />
              </Button>
            </div>
          </div>
        ) : null}

        {baseUrlError ? <div className={errorBannerClass}>{baseUrlError}</div> : null}

        {statusMessage && !authError && !workersError && !orgsError && !templateError ? (
          <div className={softNoticeClass}>{statusMessage}</div>
        ) : null}
      </div>

      {!isSignedIn ? (
        <div className={`${settingsPanelClass} space-y-4`}>
          <div className="space-y-2">
            <div className="text-sm font-medium text-dls-text">{tr("den.signin_title")}</div>
            <div className="max-w-[54ch] text-sm text-dls-secondary">
              {tr("den.cloud_sleep_hint")}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => openBrowserAuth("sign-in")}>
              {tr("den.signin_button")}
              <ArrowUpRight size={13} />
            </Button>
            <Button
              variant="outline"
              className="h-9 px-3 text-xs"
              onClick={() => openBrowserAuth("sign-up")}
            >
              {tr("den.create_account")}
              <ArrowUpRight size={13} />
            </Button>
            <Button
              variant="outline"
              className="h-9 px-3 text-xs"
              onClick={() => {
                setManualAuthOpen((value) => !value);
                setAuthError(null);
              }}
              disabled={authBusy || sessionBusy}
            >
              {manualAuthOpen ? tr("den.hide_signin_code") : tr("den.paste_signin_code")}
            </Button>
          </div>

          {manualAuthOpen ? (
            <div className={`${settingsPanelSoftClass} space-y-3`}>
              <TextInput
                label={tr("den.signin_link_label")}
                value={manualAuthInput}
                onChange={(event) => setManualAuthInput(event.currentTarget.value)}
                placeholder={tr("den.signin_link_placeholder")}
                disabled={authBusy || sessionBusy}
                hint={tr("den.signin_link_hint")}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  className="h-9 px-3 text-xs"
                  onClick={() => void submitManualAuth()}
                  disabled={authBusy || sessionBusy || !manualAuthInput.trim()}
                >
                  {authBusy ? tr("den.finishing") : tr("den.finish_signin")}
                </Button>
                <div className="text-[11px] text-dls-secondary">{tr("den.signin_code_note")}</div>
              </div>
            </div>
          ) : null}

          {authError ? <div className={errorBannerClass}>{authError}</div> : null}

          <div className={`${settingsPanelSoftClass} text-sm text-gray-10`}>
            {tr("den.auto_reconnect_hint")}
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <div className={`${settingsPanelClass} space-y-4`}>
            <div>
              <div className="text-sm font-medium text-dls-text">{tr("den.cloud_account_title")}</div>
              <div className="mt-1 text-xs text-dls-secondary">{tr("den.cloud_account_hint")}</div>
            </div>

            <div className="flex flex-col gap-3">
              <div className="ow-soft-card-quiet flex flex-col gap-3 rounded-xl p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-dls-text">{user?.name || user?.email}</div>
                  <div className="truncate text-xs text-dls-secondary">{user?.email}</div>
                </div>
                <Button
                  variant="outline"
                  className={`h-10 shrink-0 px-4 text-sm ${quietControlClass}`}
                  onClick={() => void signOut()}
                  disabled={authBusy || sessionBusy}
                >
                  <LogOut size={13} className="mr-1.5" />
                  {authBusy ? tr("den.signing_out") : tr("den.sign_out")}
                </Button>
              </div>

              <div className="ow-soft-card-quiet flex flex-col gap-3 rounded-xl p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-dls-text">{tr("den.active_org_title")}</div>
                  <div className="truncate text-xs text-dls-secondary">{tr("den.active_org_hint")}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <select
                    className={`ow-input h-10 max-w-[260px] rounded-xl px-4 py-2 text-sm font-medium text-dls-text ${quietControlClass}`}
                    value={activeOrgId}
                    onChange={(event) => {
                      const nextId = event.currentTarget.value;
                      const nextOrg = orgs.find((org) => org.id === nextId) ?? null;
                      setActiveOrgId(nextId);
                      writeDenSettings({
                        baseUrl,
                        authToken: authToken || null,
                        activeOrgId: nextId || null,
                        activeOrgSlug: nextOrg?.slug ?? null,
                        activeOrgName: nextOrg?.name ?? null,
                      });
                      // Sync Better-Auth's active org so the next request
                      // resolves against `nextId` (mirrors Solid ac41d58b).
                      if (nextId) {
                        void ensureDenActiveOrganization({
                          forceServerSync: true,
                        }).catch(() => null);
                      }
                      setStatusMessage(tx("den.org_switched", { name: nextOrg?.name ?? tr("den.active_org_title") }));
                    }}
                    disabled={orgsBusy || orgs.length === 0}
                  >
                    {orgs.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name} {org.role === "owner" ? tr("den.org_owner_suffix") : tr("den.org_member_suffix")}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="outline"
                    className={`h-10 px-4 text-sm ${quietControlClass}`}
                    onClick={() => void refreshOrgs()}
                    disabled={orgsBusy}
                  >
                    <RefreshCcw size={13} className={orgsBusy ? "animate-spin" : ""} />
                  </Button>
                </div>
              </div>
            </div>

            {orgsError ? <div className={errorBannerClass}>{orgsError}</div> : null}
          </div>

          <div className={`${settingsPanelClass} space-y-4`}>
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-dls-text">
                  <Package size={15} className="text-dls-secondary" />
                  {tr("den.cloud_skills_title")}
                </div>
                <div className="mt-1 text-xs text-dls-secondary">{tr("den.cloud_skills_hint")}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className={sectionPillClass}>
                  <Users size={12} />
                  {activeOrgName}
                </div>
                <Button
                  variant="outline"
                  className="h-8 px-3 text-xs"
                  onClick={() => void refreshSkills()}
                  disabled={skillsBusy || !activeOrgId.trim()}
                >
                  <RefreshCcw size={13} className={skillsBusy ? "animate-spin" : ""} />
                  {tr("den.refresh")}
                </Button>
              </div>
            </div>

            {skillActionError || props.extensions.cloudOrgSkillsStatus() ? (
              <div className={errorBannerClass}>{skillActionError || props.extensions.cloudOrgSkillsStatus()}</div>
            ) : null}

            {!skillsBusy && skillRows.length === 0 ? (
              <div className={`${settingsPanelSoftClass} border-dashed py-6 text-center text-sm text-dls-secondary`}>
                {activeOrgId.trim() ? tr("den.no_cloud_skills") : tr("den.choose_org_for_skills")}
              </div>
            ) : null}

            <div className="space-y-1">
              {skillRows.map((row) => {
                const actionBusy = skillActionId === row.cloudSkillId;
                const actionLabel = !actionBusy
                  ? null
                  : skillActionKind === "import"
                    ? tr("den.importing")
                    : skillActionKind === "sync"
                      ? tr("den.syncing")
                      : tr("den.removing");

                return (
                  <div
                    key={row.key}
                    className="flex items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] transition-colors hover:bg-[#f8fafc]"
                  >
                    <div className="min-w-0 pr-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium text-dls-text">{row.title}</span>
                        {row.skill?.hubName ? (
                          <span className={sectionPillClass}>{tx("skills.cloud_hub_label", { name: row.skill.hubName })}</span>
                        ) : null}
                        {row.skill?.shared === "org" ? <span className={sectionPillClass}>{tr("skills.cloud_shared_org")}</span> : null}
                        {row.skill?.shared === "public" ? <span className={sectionPillClass}>{tr("skills.cloud_shared_public")}</span> : null}
                        {row.skill?.shared === null && !row.skill?.hubName ? <span className={sectionPillClass}>{tr("den.private_badge")}</span> : null}
                        {row.installedName ? (
                          <span className={sectionPillClass}>{tx("den.installed_name_badge", { name: row.installedName })}</span>
                        ) : null}
                        {row.status !== "available" ? (
                          <span className={sectionPillClass}>
                            {row.status === "installed"
                              ? tr("den.imported_badge")
                              : row.status === "out_of_sync"
                                ? tr("den.out_of_sync_badge")
                                : tr("den.removed_from_cloud_badge")}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-dls-secondary">
                        {row.status === "available"
                          ? tx("den.cloud_skill_detail", { title: row.title })
                          : row.status === "installed"
                            ? tx("den.cloud_skill_imported_detail", { name: row.installedName ?? row.title })
                            : row.status === "out_of_sync"
                              ? tx("den.cloud_skill_sync_detail", { name: row.installedName ?? row.title })
                              : tx("den.cloud_skill_removed_detail", { name: row.installedName ?? row.title })}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {row.status === "out_of_sync" && row.skill ? (
                        <Button
                          variant="secondary"
                          className="h-8 px-4 text-xs"
                          onClick={() => void handleSyncSkill(row.cloudSkillId, row.title)}
                          disabled={skillActionId !== null}
                        >
                          {actionBusy && skillActionKind === "sync" ? tr("den.syncing") : tr("den.sync")}
                        </Button>
                      ) : null}
                      <Button
                        variant={row.status === "available" ? "secondary" : "outline"}
                        className="h-8 px-4 text-xs"
                        onClick={() => {
                          if (row.status === "available" && row.skill) {
                            return void handleImportSkill(row.cloudSkillId, row.title);
                          }
                          return void handleRemoveSkill(row.cloudSkillId, row.title);
                        }}
                        disabled={skillActionId !== null}
                      >
                        {actionBusy ? actionLabel : row.status === "available" ? tr("den.import_skill") : tr("den.uninstall")}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className={`${settingsPanelClass} space-y-4`}>
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-dls-text">
                  <Server size={15} className="text-dls-secondary" />
                  {tr("den.cloud_workers_title")}
                </div>
                <div className="mt-1 text-xs text-dls-secondary">{tr("den.cloud_workers_hint")}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className={sectionPillClass}>
                  <Users size={12} />
                  {activeOrgName}
                </div>
                <Button
                  variant="outline"
                  className="h-8 px-3 text-xs"
                  onClick={() => void refreshWorkers()}
                  disabled={workersBusy || !activeOrgId.trim()}
                >
                  <RefreshCcw size={13} className={workersBusy ? "animate-spin" : ""} />
                  {tr("den.refresh")}
                </Button>
              </div>
            </div>

            {workersError ? <div className={errorBannerClass}>{workersError}</div> : null}

            {!workersBusy && workers.length === 0 ? (
              <div className={`${settingsPanelSoftClass} border-dashed py-6 text-center text-sm text-dls-secondary`}>
                {tr("den.no_cloud_workers")}
              </div>
            ) : null}

            <div className="space-y-1">
              {workers.map((worker) => {
                const status = workerStatusMeta(worker.status, tr);
                return (
                  <div
                    key={worker.workerId}
                    className="flex items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] transition-colors hover:bg-[#f8fafc]"
                  >
                    <div className="min-w-0 pr-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium text-dls-text">{worker.workerName}</span>
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusBadgeClass(status.tone)}`}
                        >
                          {status.label}
                        </span>
                        {worker.isMine ? <span className={sectionPillClass}>{tr("den.worker_mine_badge")}</span> : null}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-dls-secondary">
                        {worker.provider ? tx("den.worker_provider_label", { provider: worker.provider }) : tr("den.worker_secondary_cloud")}
                        {worker.instanceUrl ? <span> · {worker.instanceUrl}</span> : null}
                      </div>
                    </div>
                    <Button
                      variant="secondary"
                      className="h-8 shrink-0 px-4 text-xs"
                      onClick={() => void handleOpenWorker(worker.workerId, worker.workerName)}
                      disabled={openingWorkerId !== null || !status.canOpen}
                      title={!status.canOpen ? tr("den.worker_not_ready_title") : undefined}
                    >
                      {openingWorkerId === worker.workerId ? tr("den.opening") : tr("den.open")}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className={`${settingsPanelClass} space-y-4`}>
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-dls-text">
                  <Boxes size={15} className="text-dls-secondary" />
                  {tr("den.team_templates_title")}
                </div>
                <div className="mt-1 text-xs text-dls-secondary">{tr("den.team_templates_hint")}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className={sectionPillClass}>
                  <Users size={12} />
                  {activeOrgName}
                </div>
                <Button
                  variant="outline"
                  className="h-8 px-3 text-xs"
                  onClick={() => void refreshTemplates()}
                  disabled={templatesBusy || !activeOrg?.slug?.trim()}
                >
                  <RefreshCcw size={13} className={templatesBusy ? "animate-spin" : ""} />
                  {tr("den.refresh")}
                </Button>
              </div>
            </div>

            {templateError ? <div className={errorBannerClass}>{templateError}</div> : null}

            {!templatesBusy && templates.length === 0 ? (
              <div className={`${settingsPanelSoftClass} border-dashed py-6 text-center text-sm text-dls-secondary`}>
                {activeOrg?.slug?.trim() ? tr("den.no_team_templates") : tr("den.choose_org_for_templates")}
              </div>
            ) : null}

            <div className="space-y-1">
              {templates.map((template) => {
                const isMine = template.creator?.userId === user?.id;
                const opening = openingTemplateId === template.id;
                return (
                  <div
                    key={template.id}
                    className="flex items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] transition-colors hover:bg-[#f8fafc]"
                  >
                    <div className="min-w-0 pr-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium text-dls-text">{template.name}</span>
                        <span className={sectionPillClass}>{tr("den.team_template_badge")}</span>
                        {isMine ? <span className={sectionPillClass}>{tr("den.worker_mine_badge")}</span> : null}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-dls-secondary">
                        by {templateCreatorLabel(template, tr)} · {formatTemplateTimestamp(template.createdAt, tr)}
                      </div>
                    </div>
                    <Button
                      variant="secondary"
                      className="h-8 shrink-0 px-4 text-xs"
                      onClick={() => void handleOpenTemplate(template)}
                      disabled={openingTemplateId !== null}
                    >
                      {opening ? tr("den.opening") : tr("den.open")}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className={`${settingsPanelClass} space-y-4`}>
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-dls-text">
                  <Boxes size={15} className="text-dls-secondary" />
                  {tr("den.skill_hubs_title")}
                </div>
                <div className="mt-1 text-xs text-dls-secondary">{tr("den.skill_hubs_hint")}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className={sectionPillClass}>
                  <Users size={12} />
                  {activeOrgName}
                </div>
                <Button
                  variant="outline"
                  className="h-8 px-3 text-xs"
                  onClick={() => void refreshSkillHubs()}
                  disabled={skillHubsBusy || !activeOrgId.trim()}
                >
                  <RefreshCcw size={13} className={skillHubsBusy ? "animate-spin" : ""} />
                  {tr("den.refresh")}
                </Button>
              </div>
            </div>

            {skillHubActionError || props.extensions.cloudOrgSkillHubsStatus() ? (
              <div className={errorBannerClass}>{skillHubActionError || props.extensions.cloudOrgSkillHubsStatus()}</div>
            ) : null}

            {!skillHubsBusy && skillHubRows.length === 0 ? (
              <div className={`${settingsPanelSoftClass} border-dashed py-6 text-center text-sm text-dls-secondary`}>
                {activeOrgId.trim() ? tr("den.no_skill_hubs") : tr("den.choose_org_for_skill_hubs")}
              </div>
            ) : null}

            <div className="space-y-1">
              {skillHubRows.map((row) => {
                const actionBusy = skillHubActionId === row.hubId;
                const actionLabel = !actionBusy
                  ? null
                  : skillHubActionKind === "import"
                    ? tr("den.importing")
                    : skillHubActionKind === "sync"
                      ? tr("den.syncing")
                      : tr("den.removing");

                return (
                  <div
                    key={row.key}
                    className="flex items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] transition-colors hover:bg-[#f8fafc]"
                  >
                    <div className="min-w-0 pr-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium text-dls-text">{row.name}</span>
                        <span className={sectionPillClass}>
                          {tx("den.skill_hub_skills_badge", { count: row.hub?.skills.length ?? row.importedSkillCount })}
                        </span>
                        {row.status !== "available" ? (
                          <span className={sectionPillClass}>
                            {row.status === "imported"
                              ? tr("den.imported_badge")
                              : row.status === "out_of_sync"
                                ? tr("den.out_of_sync_badge")
                                : tr("den.removed_from_cloud_badge")}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-dls-secondary">
                        {row.status === "available"
                          ? tx("den.skill_hub_detail", { count: row.liveSkillCount })
                          : row.status === "imported"
                            ? tx("den.skill_hub_imported_detail", { count: row.importedSkillCount })
                            : row.status === "out_of_sync"
                              ? tx("den.skill_hub_sync_detail", {
                                  liveCount: row.liveSkillCount,
                                  importedCount: row.importedSkillCount,
                                })
                              : tx("den.skill_hub_removed_detail", { importedCount: row.importedSkillCount })}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {row.status === "out_of_sync" && row.hub ? (
                        <Button
                          variant="secondary"
                          className="h-8 px-4 text-xs"
                          onClick={() => void handleSyncSkillHub(row.hubId)}
                          disabled={skillHubActionId !== null}
                        >
                          {actionBusy && skillHubActionKind === "sync" ? tr("den.syncing") : tr("den.sync")}
                        </Button>
                      ) : null}
                      <Button
                        variant={row.status === "available" ? "secondary" : "outline"}
                        className="h-8 px-4 text-xs"
                        onClick={() => {
                          if (row.status === "available" && row.hub) return void handleImportSkillHub(row.hubId);
                          return void handleRemoveSkillHub(row.hubId);
                        }}
                        disabled={skillHubActionId !== null}
                      >
                        {actionBusy
                          ? actionLabel
                          : row.status === "available"
                            ? tr("den.import_all")
                            : row.status === "removed_from_cloud"
                              ? tr("den.uninstall")
                              : tr("common.remove")}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className={`${settingsPanelClass} space-y-4`}>
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-dls-text">
                  <Brain size={15} className="text-dls-secondary" />
                  {tr("den.cloud_providers_title")}
                </div>
                <div className="mt-1 text-xs text-dls-secondary">{tr("den.cloud_providers_hint")}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className={sectionPillClass}>
                  <Users size={12} />
                  {activeOrgName}
                </div>
                <Button
                  variant="outline"
                  className="h-8 px-3 text-xs"
                  onClick={() => void refreshProviders()}
                  disabled={providersBusy || !activeOrgId.trim()}
                >
                  <RefreshCcw size={13} className={providersBusy ? "animate-spin" : ""} />
                  {tr("den.refresh")}
                </Button>
              </div>
            </div>

            {providerActionError ? <div className={errorBannerClass}>{providerActionError}</div> : null}

            {!providersBusy && providerRows.length === 0 ? (
              <div className={`${settingsPanelSoftClass} border-dashed py-6 text-center text-sm text-dls-secondary`}>
                {activeOrgId.trim() ? tr("den.no_cloud_providers") : tr("den.choose_org_for_providers")}
              </div>
            ) : null}

            <div className="space-y-1">
              {providerRows.map((row) => {
                const actionBusy = providerActionId === row.cloudProviderId;
                const actionLabel = !actionBusy
                  ? null
                  : providerActionKind === "import"
                    ? tr("den.importing")
                    : providerActionKind === "sync"
                      ? tr("den.syncing")
                      : tr("den.removing");

                return (
                  <div
                    key={row.key}
                    className="flex items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] transition-colors hover:bg-[#f8fafc]"
                  >
                    <div className="min-w-0 pr-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium text-dls-text">{row.name}</span>
                        <span className={sectionPillClass}>
                          <KeyRound size={12} />
                          {row.provider?.providerId ?? row.imported?.providerId}
                        </span>
                        {row.provider?.hasApiKey ? <span className={sectionPillClass}>{tr("den.credentials_ready_badge")}</span> : null}
                        {row.status !== "available" ? (
                          <span className={sectionPillClass}>
                            {row.status === "imported"
                              ? tr("den.imported_badge")
                              : row.status === "out_of_sync"
                                ? tr("den.out_of_sync_badge")
                                : tr("den.removed_from_cloud_badge")}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-dls-secondary">
                        {row.status === "removed_from_cloud"
                          ? tx("den.cloud_provider_removed_detail", { providerId: row.imported?.providerId ?? row.name })
                          : row.status === "out_of_sync"
                            ? tx("den.cloud_provider_sync_detail", {
                                count: row.provider?.models.length ?? 0,
                                source: row.provider?.source === "custom" ? "custom" : "managed",
                              })
                            : tx("den.cloud_provider_detail", {
                                count: row.provider?.models.length ?? 0,
                                source: row.provider?.source === "custom" ? "custom" : "managed",
                              })}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {row.status === "out_of_sync" && row.provider ? (
                        <Button
                          variant="secondary"
                          className="h-8 px-4 text-xs"
                          onClick={() => void handleSyncProvider(row.cloudProviderId, row.name)}
                          disabled={providerActionId !== null}
                        >
                          {actionBusy && providerActionKind === "sync" ? tr("den.syncing") : tr("den.sync")}
                        </Button>
                      ) : null}
                      <Button
                        variant={row.status === "available" ? "secondary" : "outline"}
                        className="h-8 px-4 text-xs"
                        onClick={() => {
                          if (row.status === "available" && row.provider) {
                            return void handleImportProvider(row.cloudProviderId, row.name);
                          }
                          return void handleRemoveProvider(row.cloudProviderId, row.name);
                        }}
                        disabled={providerActionId !== null}
                      >
                        {actionBusy
                          ? actionLabel
                          : row.status === "available"
                            ? tr("den.import_provider")
                            : row.status === "removed_from_cloud"
                              ? tr("den.uninstall")
                              : tr("common.remove")}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DenSettingsPanel;
