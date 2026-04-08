import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { ArrowUpRight, Boxes, Brain, Cloud, KeyRound, LogOut, Package, RefreshCcw, Server, Users } from "lucide-solid";

import Button from "./button";
import TextInput from "./text-input";
import { currentLocale, t, td, type SourceFirstTranslate } from "../../i18n";
import {
  buildDenAuthUrl,
  clearDenSession,
  DEFAULT_DEN_BASE_URL,
  DenApiError,
  type DenOrgSkillHub,
  type DenOrgLlmProvider,
  type DenTemplate,
  createDenClient,
  normalizeDenBaseUrl,
  readDenSettings,
  resolveDenBaseUrls,
  writeDenSettings,
} from "../lib/den";
import type { DenOrgSkillCard } from "../types";
import type { CloudImportedProvider, CloudImportedSkill, CloudImportedSkillHub } from "../cloud/import-state";
import {
  denSessionUpdatedEvent,
  dispatchDenSessionUpdated,
  type DenSessionUpdatedDetail,
} from "../lib/den-session-events";
import {
  clearDenTemplateCache,
  loadDenTemplateCache,
  readDenTemplateCacheSnapshot,
} from "../lib/den-template-cache";
import { usePlatform } from "../context/platform";
import { useExtensions } from "../extensions/provider";

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
  cloudOrgProviders: DenOrgLlmProvider[];
  importedCloudProviders: Record<string, CloudImportedProvider>;
  refreshCloudOrgProviders: (options?: { force?: boolean }) => Promise<DenOrgLlmProvider[]>;
  connectCloudProvider: (cloudProviderId: string) => Promise<string | void>;
  removeCloudProvider: (cloudProviderId: string) => Promise<string | void>;
};

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

function workerStatusMeta(status: string, tr: SourceFirstTranslate) {
  const normalized = status.trim().toLowerCase();
  switch (normalized) {
    case "healthy":
      return { label: tr("dashboard.worker_status_ready", "Ready"), tone: "ready" as const, canOpen: true };
    case "provisioning":
      return { label: tr("dashboard.worker_status_starting", "Starting"), tone: "warning" as const, canOpen: false };
    case "failed":
      return { label: tr("dashboard.worker_status_attention", "Attention"), tone: "error" as const, canOpen: false };
    case "stopped":
      return { label: tr("dashboard.worker_status_stopped", "Stopped"), tone: "neutral" as const, canOpen: false };
    default:
      return {
        label: normalized
          ? `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`
          : tr("dashboard.worker_status_unknown", "Unknown"),
        tone: "neutral" as const,
        canOpen: normalized === "ready",
      };
  }
}

export default function DenSettingsPanel(props: DenSettingsPanelProps) {
  const platform = usePlatform();
  const extensions = useExtensions();
  const tr = (key: string, defaultValue: string) => td(key, defaultValue, currentLocale());
  const initial = readDenSettings();
  const initialBaseUrl = initial.baseUrl || DEFAULT_DEN_BASE_URL;

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
  const [skillHubsBusy, setSkillHubsBusy] = createSignal(false);
  const [skillHubActionId, setSkillHubActionId] = createSignal<string | null>(null);
  const [skillHubActionKind, setSkillHubActionKind] = createSignal<"import" | "remove" | "sync" | null>(null);
  const [skillHubActionError, setSkillHubActionError] = createSignal<string | null>(null);
  const [skillsBusy, setSkillsBusy] = createSignal(false);
  const [skillActionId, setSkillActionId] = createSignal<string | null>(null);
  const [skillActionKind, setSkillActionKind] = createSignal<"import" | "remove" | "sync" | null>(null);
  const [skillActionError, setSkillActionError] = createSignal<string | null>(null);
  const [providersBusy, setProvidersBusy] = createSignal(false);
  const [providerActionId, setProviderActionId] = createSignal<string | null>(null);
  const [providerActionKind, setProviderActionKind] = createSignal<"import" | "remove" | "sync" | null>(null);
  const [providerActionError, setProviderActionError] = createSignal<string | null>(null);

  const activeOrg = createMemo(() => orgs().find((org) => org.id === activeOrgId()) ?? null);
  const client = createMemo(() =>
    createDenClient({ baseUrl: baseUrl(), token: authToken() }),
  );
  const isSignedIn = createMemo(() => Boolean(user() && authToken().trim()));
  const activeOrgName = createMemo(() => activeOrg()?.name || tr("den.no_org_selected", "No org selected"));
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
  const skillHubImports = createMemo(() => extensions.importedCloudSkillHubs());
  const skillHubRows = createMemo<CloudSkillHubRow[]>(() => {
    const liveHubs = extensions.cloudOrgSkillHubs();
    const imported = skillHubImports();
    const rows: CloudSkillHubRow[] = liveHubs.map((hub) => {
      const importedHub = imported[hub.id] ?? null;
      const currentSkillIds = sortStrings(hub.skills.map((skill) => skill.id));
      const importedSkillIds = sortStrings(importedHub?.skillIds ?? []);
      const status = !importedHub
        ? "available"
        : sameStringList(currentSkillIds, importedSkillIds)
          ? "imported"
          : "out_of_sync";
      return {
        key: `live:${hub.id}`,
        hubId: hub.id,
        name: hub.name,
        hub,
        imported: importedHub,
        status,
        liveSkillCount: hub.skills.length,
        importedSkillCount: importedHub?.skillNames.length ?? 0,
      };
    });

    for (const importedHub of Object.values(imported)) {
      if (liveHubs.some((hub) => hub.id === importedHub.hubId)) continue;
      rows.push({
        key: `imported:${importedHub.hubId}`,
        hubId: importedHub.hubId,
        name: importedHub.name,
        hub: null,
        imported: importedHub,
        status: "removed_from_cloud",
        liveSkillCount: 0,
        importedSkillCount: importedHub.skillNames.length,
      });
    }

    return rows;
  });
  const installedSkillNames = createMemo(() => new Set(extensions.skills().map((skill) => skill.name)));
  const skillRows = createMemo<CloudSkillRow[]>(() => {
    const liveSkills = extensions.cloudOrgSkills();
    const imported = extensions.importedCloudSkills();
    const installedNames = installedSkillNames();
    const rows: CloudSkillRow[] = liveSkills.map((skill) => {
      const importedSkill = imported[skill.id] ?? null;
      const remoteUpdatedAt = skill.updatedAt ? Date.parse(skill.updatedAt) : Number.NaN;
      const importedUpdatedAt = importedSkill?.updatedAt ? Date.parse(importedSkill.updatedAt) : Number.NaN;
      const installedName = importedSkill?.installedName?.trim() || null;
      const installedLocally = installedName ? installedNames.has(installedName) : false;
      const status = !importedSkill
        ? "available"
        : !installedLocally
          ? "out_of_sync"
          : Number.isFinite(remoteUpdatedAt) && (!Number.isFinite(importedUpdatedAt) || remoteUpdatedAt > importedUpdatedAt)
            ? "out_of_sync"
            : "installed";

      return {
        key: `live:${skill.id}`,
        cloudSkillId: skill.id,
        skill,
        imported: importedSkill,
        status,
        title: skill.title,
        installedName,
      };
    });

    for (const importedSkill of Object.values(imported)) {
      if (liveSkills.some((skill) => skill.id === importedSkill.cloudSkillId)) continue;
      rows.push({
        key: `imported:${importedSkill.cloudSkillId}`,
        cloudSkillId: importedSkill.cloudSkillId,
        skill: null,
        imported: importedSkill,
        status: "removed_from_cloud",
        title: importedSkill.title,
        installedName: importedSkill.installedName,
      });
    }

    return rows.sort((a, b) => a.title.localeCompare(b.title));
  });
  const providerRows = createMemo<CloudProviderRow[]>(() => {
    const imported = props.importedCloudProviders;
    const rows: CloudProviderRow[] = props.cloudOrgProviders.map((provider) => {
      const importedProvider = imported[provider.id] ?? null;
      const status = !importedProvider
        ? "available"
        : importedProvider.providerId !== provider.providerId ||
            (importedProvider.source ?? null) !== provider.source ||
            (importedProvider.updatedAt ?? null) !== (provider.updatedAt ?? null) ||
            !sameStringList(importedProvider.modelIds, sortStrings(provider.models.map((model) => model.id)))
          ? "out_of_sync"
          : "imported";
      return {
        key: `live:${provider.id}`,
        cloudProviderId: provider.id,
        provider,
        imported: importedProvider,
        status,
        name: provider.name,
      };
    });

    for (const importedProvider of Object.values(imported)) {
      if (props.cloudOrgProviders.some((provider) => provider.id === importedProvider.cloudProviderId)) continue;
      rows.push({
        key: `imported:${importedProvider.cloudProviderId}`,
        cloudProviderId: importedProvider.cloudProviderId,
        provider: null,
        imported: importedProvider,
        status: "removed_from_cloud",
        name: importedProvider.name,
      });
    }

    return rows;
  });

  const summaryTone = createMemo(() => {
    if (authError() || workersError() || orgsError() || templatesError() || skillActionError() || providerActionError() || skillHubActionError()) return "error" as const;
    if (sessionBusy() || orgsBusy() || workersBusy() || templatesBusy() || skillsBusy() || providersBusy() || skillHubsBusy()) return "warning" as const;
    if (isSignedIn()) return "ready" as const;
    return "neutral" as const;
  });

  const summaryLabel = createMemo(() => {
    if (authError()) return tr("den.needs_attention", "Needs attention");
    if (sessionBusy()) return tr("den.checking_session", "Checking session");
    if (isSignedIn()) return td("dashboard.connected", "Connected", currentLocale());
    return tr("den.signed_out", "Signed out");
  });

  createEffect(() => {
    writeDenSettings({
      baseUrl: baseUrl(),
      authToken: authToken() || null,
      activeOrgId: activeOrgId() || null,
      activeOrgSlug: activeOrg()?.slug ?? null,
      activeOrgName: activeOrg()?.name ?? null,
    });
  });

  const openControlPlane = () => {
    platform.openLink(resolveDenBaseUrls(baseUrl()).baseUrl);
  };

  const openBrowserAuth = (mode: "sign-in" | "sign-up") => {
    platform.openLink(buildDenAuthUrl(baseUrl(), mode));
    setStatusMessage(
      mode === "sign-up"
        ? tr("den.status_browser_signup", "Finish account creation in your browser to connect OpenWork.")
        : tr("den.status_browser_signin", "Finish signing in in your browser to connect OpenWork."),
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
        setAuthError(tr("den.error_paste_valid_code", "Paste a valid OpenWork sign-in link or one-time sign-in code."));
      }
      return;
    }

    const nextBaseUrl = parsed.baseUrl ?? baseUrl();

    setAuthBusy(true);
    setAuthError(null);
    setStatusMessage(tr("den.signing_in", "Finishing OpenWork Cloud sign-in..."));

    try {
      const result = await createDenClient({ baseUrl: nextBaseUrl }).exchangeDesktopHandoff(parsed.grant);
      if (!result.token) {
        throw new Error(tr("den.error_no_token", "Desktop sign-in completed, but OpenWork Cloud did not return a session token."));
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
        message:
          error instanceof Error
            ? error.message
            : tr("den.error_signin_failed", "Failed to complete OpenWork Cloud sign-in."),
      });
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
    setSkillHubActionError(null);
    setProviderActionError(null);
    setSkillHubActionKind(null);
    setProviderActionKind(null);
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
    setSkillHubActionId(null);
    setProviderActionId(null);
    setSkillHubActionKind(null);
    setProviderActionKind(null);
    clearSessionState();
    setBaseUrlError(null);
    setAuthError(null);
    setStatusMessage(message ?? null);
  };

  const applyBaseUrl = () => {
    const normalized = normalizeDenBaseUrl(baseUrlDraft());
    if (!normalized) {
      setBaseUrlError(tr("den.error_base_url", "Enter a valid http:// or https:// Cloud control plane URL."));
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
    clearSignedInState(tr("den.status_base_url_updated", "Updated the Cloud control plane URL. Sign in again to continue."));
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
        baseUrl: baseUrl(),
        authToken: authToken() || null,
        activeOrgId: next || null,
        activeOrgSlug: nextOrg?.slug ?? null,
        activeOrgName: nextOrg?.name ?? null,
      });
      if (!quiet && response.orgs.length > 0) {
        setStatusMessage(
          td("den.status_loaded_orgs", "Loaded {count} org{plural}.", currentLocale(), { count: response.orgs.length, plural: response.orgs.length === 1 ? "" : "s" }),
        );
      }
    } catch (error) {
      setOrgsError(error instanceof Error ? error.message : tr("den.error_load_orgs", "Failed to load orgs."));
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
            ? td("den.status_loaded_workers", "Loaded {count} worker{plural} for {name}.", currentLocale(), { count: nextWorkers.length, plural: nextWorkers.length === 1 ? "" : "s", name: activeOrg()?.name ?? tr("den.active_org_title", "Active org") })
            : td("den.status_no_workers", "No workers found for {name}.", currentLocale(), { name: activeOrg()?.name ?? tr("den.active_org_title", "Active org") }),
        );
      }
    } catch (error) {
      setWorkersError(error instanceof Error ? error.message : tr("den.error_load_workers", "Failed to load workers."));
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
            ? td("den.status_loaded_templates", "Loaded {count} template{plural} for {name}.", currentLocale(), { count: nextTemplates.length, plural: nextTemplates.length === 1 ? "" : "s", name: activeOrg()?.name ?? tr("den.active_org_title", "Active org") })
            : td("den.status_no_templates", "No team templates found for {name}.", currentLocale(), { name: activeOrg()?.name ?? tr("den.active_org_title", "Active org") }),
        );
      }
    } catch (error) {
      if (!quiet) {
        setTemplateActionError(error instanceof Error ? error.message : tr("den.error_load_templates", "Failed to load team templates."));
      }
    }
  };

  const refreshSkillHubs = async (quiet = false) => {
    const orgId = activeOrgId().trim();
    if (!authToken().trim() || !orgId) {
      return;
    }

    setSkillHubsBusy(true);
    if (!quiet) setSkillHubActionError(null);

    try {
      await extensions.refreshCloudOrgSkillHubs({ force: true });
      if (!quiet) {
        const count = extensions.cloudOrgSkillHubs().length;
        setStatusMessage(
          count > 0
            ? `Loaded ${count} cloud skill hub${count === 1 ? "" : "s"} for ${activeOrg()?.name ?? tr("den.active_org_title", "Active org")}.`
            : `No cloud skill hubs are available for ${activeOrg()?.name ?? tr("den.active_org_title", "Active org")}.`,
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
  };

  const refreshSkills = async (quiet = false) => {
    const orgId = activeOrgId().trim();
    if (!authToken().trim() || !orgId) {
      return;
    }

    setSkillsBusy(true);
    if (!quiet) setSkillActionError(null);

    try {
      await extensions.refreshCloudOrgSkills({ force: true });
      if (!quiet) {
        const count = extensions.cloudOrgSkills().length;
        setStatusMessage(
          count > 0
            ? td("den.status_loaded_skills", "Loaded {count} cloud skill{plural} for {name}.", currentLocale(), { count, plural: count === 1 ? "" : "s", name: activeOrg()?.name ?? tr("den.active_org_title", "Active org") })
            : td("den.status_no_skills", "No cloud skills found for {name}.", currentLocale(), { name: activeOrg()?.name ?? tr("den.active_org_title", "Active org") }),
        );
      }
    } catch (error) {
      if (!quiet) {
        setSkillActionError(error instanceof Error ? error.message : tr("den.error_load_skills", "Failed to load cloud skills."));
      }
    } finally {
      setSkillsBusy(false);
    }
  };

  const refreshProviders = async (quiet = false) => {
    const orgId = activeOrgId().trim();
    if (!authToken().trim() || !orgId) {
      return;
    }

    setProvidersBusy(true);
    setProviderActionError(null);

    try {
      const items = await props.refreshCloudOrgProviders({ force: !quiet });
      if (!quiet) {
        setStatusMessage(
          items.length > 0
            ? `Loaded ${items.length} cloud provider${items.length === 1 ? "" : "s"} for ${activeOrg()?.name ?? tr("den.active_org_title", "Active org")}.`
            : `No cloud providers are available for ${activeOrg()?.name ?? tr("den.active_org_title", "Active org")}.`,
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
        setStatusMessage(td("den.status_signed_in_as", "Signed in as {email}.", currentLocale(), { email: nextUser.email }));
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof DenApiError && error.status === 401) {
          clearSignedInState();
        } else {
          clearSessionState();
        }
        setAuthError(
          error instanceof Error ? error.message : tr("den.error_no_session", "No active Cloud session found."),
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
    if (!user() || !activeOrgId().trim()) return;
    void refreshSkillHubs(true);
  });

  createEffect(() => {
    if (!user() || !activeOrgId().trim()) return;
    void refreshSkills(true);
  });

  createEffect(() => {
    if (!user() || !activeOrgId().trim()) return;
    void refreshProviders(true);
  });

  createEffect(() => {
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<DenSessionUpdatedDetail>;
      const nextSettings = readDenSettings();
      const nextBaseUrl =
        customEvent.detail?.baseUrl?.trim() ||
        nextSettings.baseUrl ||
        DEFAULT_DEN_BASE_URL;
      const nextToken =
        customEvent.detail?.token?.trim() ||
        nextSettings.authToken?.trim() ||
        "";
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
            ? td("den.status_cloud_signed_in_as", "Connected OpenWork Cloud as {email}.", currentLocale(), { email: customEvent.detail.email.trim() })
            : tr("den.status_cloud_signin_done", "Connected OpenWork Cloud."),
        );
      } else if (customEvent.detail?.status === "error") {
        setAuthError(
          customEvent.detail.message?.trim() ||
            tr("den.error_signin_failed", "Failed to complete OpenWork Cloud sign-in."),
        );
      }
    };

    window.addEventListener(
      denSessionUpdatedEvent,
      handler as EventListener,
    );
    return () =>
      window.removeEventListener(
        denSessionUpdatedEvent,
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

    clearSignedInState(tr("den.status_signed_out", "Signed out and cleared your OpenWork Cloud session on this device."));
  };

  const handleOpenWorker = async (workerId: string, workerName: string) => {
    const orgId = activeOrgId().trim();
    if (!orgId) {
      setWorkersError(tr("den.error_choose_org", "Choose an org before opening a worker."));
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
        throw new Error(tr("den.error_worker_not_ready", "Worker is not ready to open yet. Try again after provisioning finishes."));
      }

      const ok = await props.connectRemoteWorkspace({
        openworkHostUrl: openworkUrl,
        openworkToken: accessToken,
        directory: null,
        displayName: workerName,
      });
      if (!ok) {
        throw new Error(td("den.error_open_worker", "Failed to open {name} in OpenWork.", currentLocale(), { name: workerName }));
      }

      setStatusMessage(td("den.status_opened_worker", "Opened {name} in OpenWork.", currentLocale(), { name: workerName }));
    } catch (error) {
      setWorkersError(
        error instanceof Error ? error.message : td("den.error_open_worker_fallback", "Failed to open {name}.", currentLocale(), { name: workerName }),
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
      const orgName = activeOrg()?.name;
      setStatusMessage(
        orgName
          ? td("den.status_opened_template", "Opened {name} from {org}.", currentLocale(), { name: template.name, org: orgName })
          : td("den.status_opened_template_fallback", "Opened {name} from team templates.", currentLocale(), { name: template.name }),
      );
    } catch (error) {
      setTemplateActionError(error instanceof Error ? error.message : td("den.error_open_template", "Failed to open {name}.", currentLocale(), { name: template.name }));
    } finally {
      setOpeningTemplateId(null);
    }
  };

  const handleImportSkillHub = async (hubId: string) => {
    const hub = extensions.cloudOrgSkillHubs().find((entry) => entry.id === hubId);
    if (!hub || skillHubActionId()) return;

    setSkillHubActionId(hub.id);
    setSkillHubActionKind("import");
    setSkillHubActionError(null);

    try {
      const result = await extensions.importCloudOrgSkillHub(hub);
      if (!result.ok) {
        throw new Error(result.message);
      }
      setStatusMessage(`${result.message} ${td("den.reload_workspace", "Reload workspace to apply config changes.")}`);
    } catch (error) {
      setSkillHubActionError(error instanceof Error ? error.message : `Failed to import ${hub.name}.`);
    } finally {
      setSkillHubActionId(null);
      setSkillHubActionKind(null);
    }
  };

  const handleRemoveSkillHub = async (hubId: string) => {
    const imported = skillHubImports()[hubId];
    if (!imported || skillHubActionId()) return;

    setSkillHubActionId(hubId);
    setSkillHubActionKind("remove");
    setSkillHubActionError(null);

    try {
      const result = await extensions.removeCloudOrgSkillHub(hubId);
      if (!result.ok) {
        throw new Error(result.message);
      }
      setStatusMessage(`${result.message} ${td("den.reload_workspace", "Reload workspace to apply config changes.")}`);
    } catch (error) {
      setSkillHubActionError(error instanceof Error ? error.message : `Failed to remove ${imported.name}.`);
    } finally {
      setSkillHubActionId(null);
      setSkillHubActionKind(null);
    }
  };

  const handleSyncSkillHub = async (hubId: string) => {
    const hub = extensions.cloudOrgSkillHubs().find((entry) => entry.id === hubId);
    if (!hub || skillHubActionId()) return;

    setSkillHubActionId(hub.id);
    setSkillHubActionKind("sync");
    setSkillHubActionError(null);

    try {
      const result = await extensions.syncCloudOrgSkillHub(hub);
      if (!result.ok) {
        throw new Error(result.message);
      }
      setStatusMessage(`${result.message} ${td("den.reload_workspace", "Reload workspace to apply config changes.")}`);
    } catch (error) {
      setSkillHubActionError(error instanceof Error ? error.message : `Failed to sync ${hub.name}.`);
    } finally {
      setSkillHubActionId(null);
      setSkillHubActionKind(null);
    }
  };

  const handleImportSkill = async (cloudSkillId: string, title: string) => {
    const skill = extensions.cloudOrgSkills().find((entry) => entry.id === cloudSkillId);
    if (!skill || skillActionId()) return;

    setSkillActionId(cloudSkillId);
    setSkillActionKind("import");
    setSkillActionError(null);

    try {
      const result = await extensions.installCloudOrgSkill(skill);
      if (!result.ok) {
        throw new Error(result.message);
      }
      setStatusMessage(`${result.message} ${td("den.reload_workspace", "Reload workspace to apply config changes.")}`);
    } catch (error) {
      setSkillActionError(error instanceof Error ? error.message : td("den.import_skill_failed", "Failed to install {name}.", { name: title }));
    } finally {
      setSkillActionId(null);
      setSkillActionKind(null);
    }
  };

  const handleRemoveSkill = async (cloudSkillId: string, title: string) => {
    if (skillActionId()) return;

    setSkillActionId(cloudSkillId);
    setSkillActionKind("remove");
    setSkillActionError(null);

    try {
      const result = await extensions.removeCloudOrgSkill(cloudSkillId);
      if (!result.ok) {
        throw new Error(result.message);
      }
      setStatusMessage(`${result.message} ${td("den.reload_workspace", "Reload workspace to apply config changes.")}`);
    } catch (error) {
      setSkillActionError(error instanceof Error ? error.message : td("den.remove_skill_failed", "Failed to uninstall {name}.", { name: title }));
    } finally {
      setSkillActionId(null);
      setSkillActionKind(null);
    }
  };

  const handleSyncSkill = async (cloudSkillId: string, title: string) => {
    const skill = extensions.cloudOrgSkills().find((entry) => entry.id === cloudSkillId);
    if (!skill || skillActionId()) return;

    setSkillActionId(cloudSkillId);
    setSkillActionKind("sync");
    setSkillActionError(null);

    try {
      const result = await extensions.syncCloudOrgSkill(skill);
      if (!result.ok) {
        throw new Error(result.message);
      }
      setStatusMessage(`${result.message} ${td("den.reload_workspace", "Reload workspace to apply config changes.")}`);
    } catch (error) {
      setSkillActionError(error instanceof Error ? error.message : td("den.sync_skill_failed", "Failed to update {name}.", { name: title }));
    } finally {
      setSkillActionId(null);
      setSkillActionKind(null);
    }
  };

  const handleImportProvider = async (cloudProviderId: string, providerName: string) => {
    if (providerActionId()) return;

    setProviderActionId(cloudProviderId);
    setProviderActionKind("import");
    setProviderActionError(null);

    try {
      const message = await props.connectCloudProvider(cloudProviderId);
      setStatusMessage(`${message || td("den.imported_provider", "Imported {name}.", { name: providerName })} ${td("den.reload_workspace", "Reload workspace to apply config changes.")}`);
    } catch (error) {
      setProviderActionError(error instanceof Error ? error.message : td("den.import_provider_failed", "Failed to import {name}.", { name: providerName }));
    } finally {
      setProviderActionId(null);
      setProviderActionKind(null);
    }
  };

  const handleRemoveProvider = async (cloudProviderId: string, providerName: string) => {
    if (providerActionId()) return;

    setProviderActionId(cloudProviderId);
    setProviderActionKind("remove");
    setProviderActionError(null);

    try {
      const message = await props.removeCloudProvider(cloudProviderId);
      setStatusMessage(`${message || td("den.removed_provider", "Removed {name}.", { name: providerName })} ${td("den.reload_workspace", "Reload workspace to apply config changes.")}`);
    } catch (error) {
      setProviderActionError(error instanceof Error ? error.message : td("den.remove_provider_failed", "Failed to remove {name}.", { name: providerName }));
    } finally {
      setProviderActionId(null);
      setProviderActionKind(null);
    }
  };

  const handleSyncProvider = async (cloudProviderId: string, providerName: string) => {
    if (providerActionId()) return;

    setProviderActionId(cloudProviderId);
    setProviderActionKind("sync");
    setProviderActionError(null);

    try {
      await props.connectCloudProvider(cloudProviderId);
      setStatusMessage(`${td("den.synced_provider", "Synced {name}.", { name: providerName })} ${td("den.reload_workspace", "Reload workspace to apply config changes.")}`);
    } catch (error) {
      setProviderActionError(error instanceof Error ? error.message : td("den.sync_provider_failed", "Failed to sync {name}.", { name: providerName }));
    } finally {
      setProviderActionId(null);
      setProviderActionKind(null);
    }
  };

  const formatTemplateTimestamp = (value: string | null) => {
    if (!value) return tr("dashboard.recently_updated", "Recently updated");
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return tr("dashboard.recently_updated", "Recently updated");
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date);
  };

  const templateCreatorLabel = (template: DenTemplate) => {
    const creator = template.creator;
    if (!creator) return tr("dashboard.unknown_creator", "Unknown creator");
    return creator.name?.trim() || creator.email?.trim() || tr("dashboard.unknown_creator", "Unknown creator");
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
              {tr("den.cloud_section_title", "OpenWork Cloud")}
            </div>
            <div>
              <div class="text-sm font-medium text-dls-text">
                {tr("den.cloud_section_desc", "Sign in, pick an org, and open Cloud workers or team templates.")}
              </div>
              <div class="mt-1 max-w-[60ch] text-xs text-dls-secondary">
                {tr("den.cloud_sleep_hint", "Sign in to OpenWork Cloud to keep your tasks alive even when your computer sleeps.")}
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
              label={tr("den.cloud_control_plane_url_label", "Cloud control plane URL")}
              value={baseUrlDraft()}
              onInput={(event) => setBaseUrlDraft(event.currentTarget.value)}
              placeholder={DEFAULT_DEN_BASE_URL}
              hint={tr("den.cloud_control_plane_url_hint", "Developer mode only. Use this to target a local or self-hosted Cloud control plane. Changing it signs you out so the app can re-hydrate against the new control plane.")}
              disabled={authBusy() || sessionBusy()}
            />
            <div class="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                class="h-9 px-3 text-xs"
                onClick={() => setBaseUrlDraft(baseUrl())}
                disabled={authBusy() || sessionBusy()}
              >
                {tr("den.cloud_control_plane_reset", "Reset")}
              </Button>
              <Button
                variant="secondary"
                class="h-9 px-3 text-xs"
                onClick={applyBaseUrl}
                disabled={authBusy() || sessionBusy()}
              >
                {tr("den.cloud_control_plane_save", "Save URL")}
              </Button>
              <Button
                variant="outline"
                class="h-9 px-3 text-xs"
                onClick={openControlPlane}
              >
                {tr("den.cloud_control_plane_open", "Open in browser")}
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
                {tr("den.signin_title", "Sign in to OpenWork Cloud")}
              </div>
              <div class="max-w-[54ch] text-sm text-dls-secondary">
                {tr("den.cloud_sleep_hint", "Sign in to OpenWork Cloud to keep your tasks alive even when your computer sleeps.")}
              </div>
            </div>

          <div class="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => openBrowserAuth("sign-in")}>
              {tr("den.signin_button", "Sign in")}
              <ArrowUpRight size={13} />
            </Button>
            <Button
              variant="outline"
              class="text-xs h-9 px-3"
              onClick={() => openBrowserAuth("sign-up")}
            >
              {tr("den.create_account", "Create account")}
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
              {manualAuthOpen() ? tr("den.hide_signin_code", "Hide sign-in code") : tr("den.paste_signin_code", "Paste sign-in code")}
            </Button>
          </div>

          <Show when={manualAuthOpen()}>
            <div class={`${settingsPanelSoftClass} space-y-3`}>
              <TextInput
                label={tr("den.signin_link_label", "Sign-in link or one-time code")}
                value={manualAuthInput()}
                onInput={(event) => setManualAuthInput(event.currentTarget.value)}
                placeholder={tr("den.signin_link_placeholder", "openwork://den-auth?... or pasted code")}
                disabled={authBusy() || sessionBusy()}
                hint={tr("den.signin_link_hint", "If your browser doesn't bounce back into OpenWork automatically, paste the sign-in link or one-time code from OpenWork Cloud here.")}
              />
              <div class="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  class="text-xs h-9 px-3"
                  onClick={() => void submitManualAuth()}
                  disabled={authBusy() || sessionBusy() || !manualAuthInput().trim()}
                >
                  {authBusy() ? tr("den.finishing", "Finishing...") : tr("den.finish_signin", "Finish sign-in")}
                </Button>
                <div class="text-[11px] text-dls-secondary">
                  {tr("den.signin_code_note", "Accepts an openwork://den-auth link or the raw one-time grant.")}
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
            {tr("den.auto_reconnect_hint", "Finish auth in your browser and OpenWork will reconnect here automatically.")}
          </div>
        </div>
      </Show>

      <Show when={isSignedIn()}>
        <div class="space-y-6">
          <div class={`${settingsPanelClass} space-y-4`}>
            <div>
              <div class="text-sm font-medium text-dls-text">{tr("den.cloud_account_title", "Cloud account")}</div>
              <div class="mt-1 text-xs text-dls-secondary">
                {tr("den.cloud_account_hint", "Manage your connected account and organization.")}
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
                  {authBusy() ? tr("den.signing_out", "Signing out...") : tr("den.sign_out", "Sign out")}
                </Button>
              </div>

              <div class="ow-soft-card-quiet flex flex-col gap-3 rounded-xl p-3 sm:flex-row sm:items-center sm:justify-between">
                <div class="min-w-0">
                  <div class="text-sm font-medium text-dls-text">{tr("den.active_org_title", "Active org")}</div>
                  <div class="truncate text-xs text-dls-secondary">
                    {tr("den.active_org_hint", "Cloud workers and team templates are scoped to the selected org.")}
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
                        baseUrl: baseUrl(),
                        authToken: authToken() || null,
                        activeOrgId: nextId || null,
                        activeOrgSlug: nextOrg?.slug ?? null,
                        activeOrgName: nextOrg?.name ?? null,
                      });
                      setStatusMessage(
                        td("den.org_switched", "Switched to {name}.", currentLocale(), { name: nextOrg?.name ?? tr("den.active_org_title", "Active org") }),
                      );
                    }}
                    disabled={orgsBusy() || orgs().length === 0}
                  >
                    <For each={orgs()}>
                      {(org) => (
                        <option value={org.id}>
                          {org.name} {org.role === "owner" ? tr("den.org_owner_suffix", "(Owner)") : tr("den.org_member_suffix", "(Member)")}
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
                  <Package size={15} class="text-dls-secondary" />
                  {tr("den.cloud_skills_title", "Skills")}
                </div>
                <div class="mt-1 text-xs text-dls-secondary">
                  {tr("den.cloud_skills_hint", "Browse individual cloud skills you can access, install them locally, and update them when the remote version changes.")}
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
                  onClick={() => void refreshSkills()}
                  disabled={skillsBusy() || !activeOrgId().trim()}
                >
                  <RefreshCcw size={13} class={skillsBusy() ? "animate-spin" : ""} />
                  {tr("den.refresh", "Refresh")}
                </Button>
              </div>
            </div>

            <Show when={skillActionError() || extensions.cloudOrgSkillsStatus()}>
              {(value) => (
                <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
                  {value()}
                </div>
              )}
            </Show>

            <Show when={!skillsBusy() && skillRows().length === 0}>
              <div class={`${settingsPanelSoftClass} border-dashed py-6 text-center text-sm text-dls-secondary`}>
                <Show when={activeOrgId().trim()} fallback={tr("den.choose_org_for_skills", "Choose an org to view cloud skills.")}>
                  {tr("den.no_cloud_skills", "No cloud skills are available for this org yet.")}
                </Show>
              </div>
            </Show>

            <div class="space-y-1">
              <For each={skillRows()}>
                {(row) => {
                  const actionBusy = createMemo(() => skillActionId() === row.cloudSkillId);
                  const actionLabel = createMemo(() => {
                    if (!actionBusy()) return null;
                    switch (skillActionKind()) {
                      case "import":
                        return tr("den.importing", "Importing...");
                      case "sync":
                        return tr("den.syncing", "Syncing...");
                      default:
                        return tr("den.removing", "Removing...");
                    }
                  });

                  return (
                    <div class="flex items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] transition-colors hover:bg-[#f8fafc]">
                      <div class="min-w-0 pr-4">
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="truncate font-medium text-dls-text">{row.title}</span>
                          <Show when={row.skill?.hubName}>
                            <span class={sectionPillClass}>{td("skills.cloud_hub_label", "Hub: {name}", currentLocale(), { name: row.skill?.hubName ?? "" })}</span>
                          </Show>
                          <Show when={row.skill?.shared === "org"}>
                            <span class={sectionPillClass}>{tr("skills.cloud_shared_org", "Org")}</span>
                          </Show>
                          <Show when={row.skill?.shared === "public"}>
                            <span class={sectionPillClass}>{tr("skills.cloud_shared_public", "Public")}</span>
                          </Show>
                          <Show when={row.skill?.shared === null && !row.skill?.hubName}>
                            <span class={sectionPillClass}>{tr("den.private_badge", "Private")}</span>
                          </Show>
                          <Show when={row.installedName}>
                            <span class={sectionPillClass}>{td("den.installed_name_badge", "Local: {name}", currentLocale(), { name: row.installedName ?? "" })}</span>
                          </Show>
                          <Show when={row.status !== "available"}>
                            <span class={sectionPillClass}>
                              {row.status === "installed"
                                ? tr("den.imported_badge", "Imported")
                                : row.status === "out_of_sync"
                                  ? tr("den.out_of_sync_badge", "Out of sync")
                                  : tr("den.removed_from_cloud_badge", "Removed from cloud")}
                            </span>
                          </Show>
                        </div>
                        <div class="mt-0.5 truncate text-[11px] text-dls-secondary">
                          {row.status === "available"
                            ? td("den.cloud_skill_detail", "Install this cloud skill into .opencode/skills.", currentLocale(), { title: row.title })
                            : row.status === "installed"
                              ? td("den.cloud_skill_imported_detail", "Installed locally as {name}.", currentLocale(), {
                                  name: row.installedName ?? row.title,
                                })
                              : row.status === "out_of_sync"
                                ? td("den.cloud_skill_sync_detail", "A newer cloud version is available for {name}. Update the local copy to stay in sync.", currentLocale(), {
                                    name: row.installedName ?? row.title,
                                  })
                                : td("den.cloud_skill_removed_detail", "This cloud skill was removed upstream. Uninstall the local {name} copy.", currentLocale(), {
                                    name: row.installedName ?? row.title,
                                  })}
                        </div>
                      </div>
                      <div class="flex items-center gap-2 shrink-0">
                        <Show when={row.status === "out_of_sync" && row.skill}>
                          <Button
                            variant="secondary"
                            class="h-8 px-4 text-xs"
                            onClick={() => void handleSyncSkill(row.cloudSkillId, row.title)}
                            disabled={skillActionId() !== null}
                          >
                            {actionBusy() && skillActionKind() === "sync" ? tr("den.syncing", "Syncing...") : tr("den.sync", "Sync")}
                          </Button>
                        </Show>
                        <Button
                          variant={row.status === "available" ? "secondary" : "outline"}
                          class="h-8 px-4 text-xs"
                          onClick={() => {
                            if (row.status === "available" && row.skill) {
                              return void handleImportSkill(row.cloudSkillId, row.title);
                            }
                            return void handleRemoveSkill(row.cloudSkillId, row.title);
                          }}
                          disabled={skillActionId() !== null}
                        >
                          {actionBusy()
                            ? actionLabel()
                            : row.status === "available"
                              ? tr("den.import_skill", "Install")
                              : tr("den.uninstall", "Uninstall")}
                        </Button>
                      </div>
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
                  <Server size={15} class="text-dls-secondary" />
                  {tr("den.cloud_workers_title", "Cloud workers")}
                </div>
                <div class="mt-1 text-xs text-dls-secondary">
                  {tr("den.cloud_workers_hint", "Open workers directly into OpenWork using the same remote-connect flow the app already uses elsewhere.")}
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
                  {tr("den.refresh", "Refresh")}
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
                {tr("den.no_cloud_workers", "No cloud workers are visible for this org yet. Create one in Cloud, then refresh this tab.")}
              </div>
            </Show>

            <div class="space-y-1">
              <For each={workers()}>
                {(worker) => {
                  const status = createMemo(() => workerStatusMeta(worker.status, tr));
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
                              {tr("den.worker_mine_badge", "Mine")}
                            </span>
                          </Show>
                        </div>
                        <div class="mt-0.5 truncate text-[11px] text-dls-secondary">
                          {worker.provider ? td("den.worker_provider_label", "{provider} worker", currentLocale(), { provider: worker.provider }) : tr("den.worker_secondary_cloud", "Cloud worker")}
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
                        title={!status().canOpen ? tr("den.worker_not_ready_title", "This worker is not ready to open yet.") : undefined}
                      >
                        {openingWorkerId() === worker.workerId ? tr("den.opening", "Opening...") : tr("den.open", "Open")}
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
                  {tr("den.team_templates_title", "Team templates")}
                </div>
                <div class="mt-1 text-xs text-dls-secondary">
                  {tr("den.team_templates_hint", "Open reusable workspace templates shared with this organization.")}
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
                  {tr("den.refresh", "Refresh")}
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
                  fallback={tr("den.choose_org_for_templates", "Choose an org to view team templates.")}
                >
                  {tr("den.no_team_templates", "No team templates yet. Use Share → Template → Share with team.")}
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
                            {tr("den.team_template_badge", "Team template")}
                          </span>
                          <Show when={isMine()}>
                            <span class={sectionPillClass}>
                              {tr("den.worker_mine_badge", "Mine")}
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
                        {opening() ? tr("den.opening", "Opening...") : tr("den.open", "Open")}
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
                  {tr("den.skill_hubs_title", "Skill hubs")}
                </div>
                <div class="mt-1 text-xs text-dls-secondary">
                  {tr("den.skill_hubs_hint", "Import every skill from a shared cloud hub into this workspace in one step.")}
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
                  onClick={() => void refreshSkillHubs()}
                  disabled={skillHubsBusy() || !activeOrgId().trim()}
                >
                  <RefreshCcw size={13} class={skillHubsBusy() ? "animate-spin" : ""} />
                  {tr("den.refresh", "Refresh")}
                </Button>
              </div>
            </div>

            <Show when={skillHubActionError() || extensions.cloudOrgSkillHubsStatus()}>
              {(value) => (
                <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
                  {value()}
                </div>
              )}
            </Show>

            <Show when={!skillHubsBusy() && skillHubRows().length === 0}>
              <div class={`${settingsPanelSoftClass} border-dashed py-6 text-center text-sm text-dls-secondary`}>
                <Show when={activeOrgId().trim()} fallback={tr("den.choose_org_for_skill_hubs", "Choose an org to view cloud skill hubs.")}>
                  {tr("den.no_skill_hubs", "No cloud skill hubs are available for this org yet.")}
                </Show>
              </div>
            </Show>

            <div class="space-y-1">
              <For each={skillHubRows()}>
                {(row) => {
                  const actionBusy = createMemo(() => skillHubActionId() === row.hubId);
                  const actionLabel = createMemo(() => {
                    if (!actionBusy()) return null;
                    switch (skillHubActionKind()) {
                      case "import":
                        return tr("den.importing", "Importing...");
                      case "sync":
                        return tr("den.syncing", "Syncing...");
                      default:
                        return tr("den.removing", "Removing...");
                    }
                  });
                  return (
                    <div class="flex items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] transition-colors hover:bg-[#f8fafc]">
                      <div class="min-w-0 pr-4">
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="truncate font-medium text-dls-text">{row.name}</span>
                          <span class={sectionPillClass}>
                            {td("den.skill_hub_skills_badge", "{count} skills", currentLocale(), {
                              count: row.hub?.skills.length ?? row.importedSkillCount,
                            })}
                          </span>
                          <Show when={row.status !== "available"}>
                            <span class={sectionPillClass}>
                              {row.status === "imported"
                                ? tr("den.imported_badge", "Imported")
                                : row.status === "out_of_sync"
                                  ? tr("den.out_of_sync_badge", "Out of sync")
                                  : tr("den.removed_from_cloud_badge", "Removed from cloud")}
                            </span>
                          </Show>
                        </div>
                        <div class="mt-0.5 truncate text-[11px] text-dls-secondary">
                          {row.status === "available"
                            ? td("den.skill_hub_detail", "Import {count} shared skills into .opencode/skills.", currentLocale(), { count: row.liveSkillCount })
                            : row.status === "imported"
                              ? td("den.skill_hub_imported_detail", "Imported {count} skills into this workspace.", currentLocale(), {
                                  count: row.importedSkillCount,
                                })
                              : row.status === "out_of_sync"
                                ? td("den.skill_hub_sync_detail", "Cloud now has {liveCount} skills; this workspace imported {importedCount}. Sync to update the installed set.", currentLocale(), {
                                    liveCount: row.liveSkillCount,
                                    importedCount: row.importedSkillCount,
                                  })
                                : td("den.skill_hub_removed_detail", "This hub was removed from cloud. Uninstall the {importedCount} imported skills from this workspace.", currentLocale(), {
                                    importedCount: row.importedSkillCount,
                                  })}
                        </div>
                      </div>
                      <div class="flex items-center gap-2 shrink-0">
                        <Show when={row.status === "out_of_sync" && row.hub}>
                          <Button
                            variant="secondary"
                            class="h-8 px-4 text-xs"
                            onClick={() => void handleSyncSkillHub(row.hubId)}
                            disabled={skillHubActionId() !== null}
                          >
                            {actionBusy() && skillHubActionKind() === "sync" ? tr("den.syncing", "Syncing...") : tr("den.sync", "Sync")}
                          </Button>
                        </Show>
                        <Button
                          variant={row.status === "available" ? "secondary" : "outline"}
                          class="h-8 px-4 text-xs"
                          onClick={() => {
                            if (row.status === "available" && row.hub) return void handleImportSkillHub(row.hubId);
                            return void handleRemoveSkillHub(row.hubId);
                          }}
                          disabled={skillHubActionId() !== null}
                        >
                          {actionBusy()
                            ? actionLabel()
                            : row.status === "available"
                              ? tr("den.import_all", "Import all")
                              : row.status === "removed_from_cloud"
                                ? tr("den.uninstall", "Uninstall")
                                : td("common.remove", "Remove", currentLocale())}
                        </Button>
                      </div>
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
                  <Brain size={15} class="text-dls-secondary" />
                  {tr("den.cloud_providers_title", "Cloud providers")}
                </div>
                <div class="mt-1 text-xs text-dls-secondary">
                  {tr("den.cloud_providers_hint", "Import managed LLM providers into opencode.jsonc and use the org credential in this workspace.")}
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
                  onClick={() => void refreshProviders()}
                  disabled={providersBusy() || !activeOrgId().trim()}
                >
                  <RefreshCcw size={13} class={providersBusy() ? "animate-spin" : ""} />
                  {tr("den.refresh", "Refresh")}
                </Button>
              </div>
            </div>

            <Show when={providerActionError()}>
              {(value) => (
                <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
                  {value()}
                </div>
              )}
            </Show>

            <Show when={!providersBusy() && providerRows().length === 0}>
              <div class={`${settingsPanelSoftClass} border-dashed py-6 text-center text-sm text-dls-secondary`}>
                <Show when={activeOrgId().trim()} fallback={tr("den.choose_org_for_providers", "Choose an org to view cloud providers.")}>
                  {tr("den.no_cloud_providers", "No cloud providers are available for this org yet.")}
                </Show>
              </div>
            </Show>

            <div class="space-y-1">
              <For each={providerRows()}>
                {(row) => {
                  const actionBusy = createMemo(() => providerActionId() === row.cloudProviderId);
                  const actionLabel = createMemo(() => {
                    if (!actionBusy()) return null;
                    switch (providerActionKind()) {
                      case "import":
                        return tr("den.importing", "Importing...");
                      case "sync":
                        return tr("den.syncing", "Syncing...");
                      default:
                        return tr("den.removing", "Removing...");
                    }
                  });
                  return (
                    <div class="flex items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] transition-colors hover:bg-[#f8fafc]">
                      <div class="min-w-0 pr-4">
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="truncate font-medium text-dls-text">{row.name}</span>
                          <span class={sectionPillClass}>
                            <KeyRound size={12} />
                            {row.provider?.providerId ?? row.imported?.providerId}
                          </span>
                          <Show when={row.provider?.hasApiKey}>
                            <span class={sectionPillClass}>{tr("den.credentials_ready_badge", "Credential ready")}</span>
                          </Show>
                          <Show when={row.status !== "available"}>
                            <span class={sectionPillClass}>
                              {row.status === "imported"
                                ? tr("den.imported_badge", "Imported")
                                : row.status === "out_of_sync"
                                  ? tr("den.out_of_sync_badge", "Out of sync")
                                  : tr("den.removed_from_cloud_badge", "Removed from cloud")}
                            </span>
                          </Show>
                        </div>
                        <div class="mt-0.5 truncate text-[11px] text-dls-secondary">
                          {row.status === "removed_from_cloud"
                            ? td("den.cloud_provider_removed_detail", "This imported provider is no longer in cloud. Uninstall the local {providerId} config.", currentLocale(), {
                                providerId: row.imported?.providerId ?? row.name,
                              })
                            : row.status === "out_of_sync"
                              ? td("den.cloud_provider_sync_detail", "Cloud provider changed. Sync the {count} model {source} config into opencode.jsonc.", currentLocale(), {
                                  count: row.provider?.models.length ?? 0,
                                  source: row.provider?.source === "custom" ? "custom" : "managed",
                                })
                              : td("den.cloud_provider_detail", "{count} models · {source} provider", currentLocale(), {
                                  count: row.provider?.models.length ?? 0,
                                  source: row.provider?.source === "custom" ? "custom" : "managed",
                                })}
                        </div>
                      </div>
                      <div class="flex items-center gap-2 shrink-0">
                        <Show when={row.status === "out_of_sync" && row.provider}>
                          <Button
                            variant="secondary"
                            class="h-8 px-4 text-xs"
                            onClick={() => void handleSyncProvider(row.cloudProviderId, row.name)}
                            disabled={providerActionId() !== null}
                          >
                            {actionBusy() && providerActionKind() === "sync" ? tr("den.syncing", "Syncing...") : tr("den.sync", "Sync")}
                          </Button>
                        </Show>
                        <Button
                          variant={row.status === "available" ? "secondary" : "outline"}
                          class="h-8 px-4 text-xs"
                          onClick={() => {
                            if (row.status === "available" && row.provider) {
                              return void handleImportProvider(row.cloudProviderId, row.name);
                            }
                            return void handleRemoveProvider(row.cloudProviderId, row.name);
                          }}
                          disabled={providerActionId() !== null}
                        >
                          {actionBusy()
                            ? actionLabel()
                            : row.status === "available"
                              ? tr("den.import_provider", "Import")
                              : row.status === "removed_from_cloud"
                                ? tr("den.uninstall", "Uninstall")
                                : td("common.remove", "Remove", currentLocale())}
                        </Button>
                      </div>
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
