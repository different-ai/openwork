/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction,
} from "react";
import {
  ArrowLeft,
  Cloud,
  Copy,
  Edit2,
  FolderOpen,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Share2,
  Sparkles,
  Trash2,
  Upload,
  Users,
} from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/i18n";
import type { SkillBundleV1 } from "@/app/bundles";
import { saveInstalledSkillToOpenWorkOrg } from "@/app/bundles/skill-org-publish";
import {
  buildDenAuthUrl,
  createDenClient,
  DEFAULT_DEN_BASE_URL,
  readDenSettings,
  type DenOrgSkillHubSummary,
} from "../../../../app/lib/den";
import {
  DEFAULT_OPENWORK_PUBLISHER_BASE_URL,
  publishOpenworkBundleJson,
} from "../../../../app/lib/publisher";
import type {
  DenOrgSkillCard,
  HubSkillCard,
  HubSkillRepo,
  SkillCard,
} from "../../../../app/types";
import {
  inputClass,
  modalNoticeErrorClass,
  modalNoticeSuccessClass,
  pillGhostClass,
  pillPrimaryClass,
  pillSecondaryClass,
  surfaceCardClass,
  tagClass,
} from "../../workspace/modal-styles";
import { Button } from "@/components/ui/button";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import {
  SelectMenu,
  type SelectMenuOption,
} from "../../../design-system/select-menu";
import { WorkspaceOptionCard } from "../../../domains/workspace/option-card";

type InstallResult = { ok: boolean; message: string };
type SkillsFilter = "all" | "installed" | "cloud" | "hub";
type ShareSkillSubView = "chooser" | "public" | "team";
type CloudSkillInstallState = "available" | "installed" | "update" | "missing_local";
type ToastTone = "info" | "success" | "warning" | "error";

const pageTitleClass = "text-[28px] font-semibold tracking-[-0.5px] text-dls-text";
const sectionTitleClass = "text-[15px] font-medium tracking-[-0.2px] text-dls-text";
const panelCardClass =
  "rounded-[20px] border border-dls-border bg-dls-surface p-5 transition-all hover:border-dls-border hover:shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)]";

const OPENWORK_DEFAULT_SKILL_NAMES = new Set([
  "workspace-guide",
  "get-started",
  "skill-creator",
  "command-creator",
  "agent-creator",
  "plugin-creator",
]);

export type ImportedCloudSkillRecord = {
  installedName: string;
  updatedAt?: string | null;
};

export type SkillsExtensionsStore = {
  skills: () => SkillCard[];
  skillsStatus: () => string | null;
  hubSkills: () => HubSkillCard[];
  hubSkillsStatus: () => string | null;
  cloudOrgSkills: () => DenOrgSkillCard[];
  cloudOrgSkillsStatus: () => string | null;
  importedCloudSkills: () => Record<string, ImportedCloudSkillRecord>;
  hubRepo: () => HubSkillRepo | null;
  hubRepos: () => HubSkillRepo[];
  ensureHubSkillsFresh: () => void | Promise<void>;
  ensureCloudOrgSkillsFresh: () => void | Promise<void>;
  refreshSkills: (options?: { force?: boolean }) => void | Promise<void>;
  refreshHubSkills: (options?: { force?: boolean }) => void | Promise<void>;
  refreshCloudOrgSkills: (options?: { force?: boolean }) => void | Promise<void>;
  setHubRepo: (repo: HubSkillRepo) => void | Promise<void>;
  addHubRepo: (repo: HubSkillRepo) => void | Promise<void>;
  removeHubRepo: (repo: HubSkillRepo) => void | Promise<void>;
  installSkillCreator: () => Promise<InstallResult>;
  installCloudOrgSkill: (skill: DenOrgSkillCard) => Promise<InstallResult>;
  installHubSkill: (name: string) => Promise<InstallResult>;
  importLocalSkill: () => void | Promise<void>;
  revealSkillsFolder: () => void | Promise<void>;
  readSkill: (name: string) => Promise<{ content: string } | null>;
  saveSkill: (input: {
    name: string;
    content: string;
    description?: string;
  }) => void | Promise<void>;
  uninstallSkill: (name: string) => void | Promise<void>;
};

export type SkillsViewProps = {
  workspaceName: string;
  busy: boolean;
  showHeader?: boolean;
  canInstallSkillCreator: boolean;
  canUseDesktopTools: boolean;
  accessHint?: string | null;
  extensions: SkillsExtensionsStore;
  onOpenLink: (url: string) => void;
  onToast?: (input: { title: string; tone?: ToastTone }) => void;
  createSessionAndOpen: (initialPrompt?: string) => Promise<string | undefined> | string | void;
};

type SkillsViewLocalState = {
  uninstallTarget: SkillCard | null;
  searchQuery: string;
  activeFilter: SkillsFilter;
  customRepoOpen: boolean;
  customRepoOwner: string;
  customRepoName: string;
  customRepoRef: string;
  customRepoError: string | null;
  shareTarget: SkillCard | null;
  shareSubView: ShareSkillSubView;
  shareBusy: boolean;
  shareUrl: string | null;
  shareError: string | null;
  cloudSessionNonce: number;
  shareTeamBusy: boolean;
  shareTeamError: string | null;
  shareTeamSuccess: string | null;
  sharePermissionChoice: string;
  shareHubsLoading: boolean;
  shareHubsError: string | null;
  shareManageableHubs: DenOrgSkillHubSummary[];
  selectedSkill: SkillCard | null;
  selectedContent: string;
  selectedLoading: boolean;
  selectedDirty: boolean;
  selectedError: string | null;
  installingSkillCreator: boolean;
  installingHubSkill: string | null;
  installingCloudSkillId: string | null;
  denUiTick: number;
};

type SkillsViewLocalAction<K extends keyof SkillsViewLocalState = keyof SkillsViewLocalState> =
  | { type: "set"; key: K; value: SetStateAction<any> }
  | { type: "denSessionUpdated" }
  | { type: "resetShareChooser" }
  | { type: "shareHubsStart" }
  | { type: "shareHubsLoaded"; hubs: DenOrgSkillHubSummary[] }
  | { type: "shareHubsFailed"; error: string }
  | { type: "shareHubsDone" }
  | { type: "closeShare" }
  | { type: "openShare"; skill: SkillCard };

const initialSkillsViewLocalState: SkillsViewLocalState = {
  uninstallTarget: null,
  searchQuery: "",
  activeFilter: "all",
  customRepoOpen: false,
  customRepoOwner: "",
  customRepoName: "",
  customRepoRef: "main",
  customRepoError: null,
  shareTarget: null,
  shareSubView: "chooser",
  shareBusy: false,
  shareUrl: null,
  shareError: null,
  cloudSessionNonce: 0,
  shareTeamBusy: false,
  shareTeamError: null,
  shareTeamSuccess: null,
  sharePermissionChoice: "org",
  shareHubsLoading: false,
  shareHubsError: null,
  shareManageableHubs: [],
  selectedSkill: null,
  selectedContent: "",
  selectedLoading: false,
  selectedDirty: false,
  selectedError: null,
  installingSkillCreator: false,
  installingHubSkill: null,
  installingCloudSkillId: null,
  denUiTick: 0,
};

function skillsViewLocalReducer(
  state: SkillsViewLocalState,
  action: SkillsViewLocalAction,
): SkillsViewLocalState {
  switch (action.type) {
    case "set": {
      const current = state[action.key];
      const next =
        typeof action.value === "function"
          ? (action.value as (value: typeof current) => typeof current)(current)
          : action.value;
      if (Object.is(current, next)) return state;
      return { ...state, [action.key]: next };
    }
    case "denSessionUpdated":
      return {
        ...state,
        denUiTick: state.denUiTick + 1,
        cloudSessionNonce: state.cloudSessionNonce + 1,
      };
    case "resetShareChooser":
      return {
        ...state,
        shareSubView: "chooser",
        shareError: null,
        shareTeamError: null,
        shareTeamSuccess: null,
        sharePermissionChoice: "org",
        shareHubsError: null,
      };
    case "shareHubsStart":
      return { ...state, shareHubsLoading: true, shareHubsError: null };
    case "shareHubsLoaded":
      return { ...state, shareManageableHubs: action.hubs };
    case "shareHubsFailed":
      return { ...state, shareHubsError: action.error, shareManageableHubs: [] };
    case "shareHubsDone":
      return { ...state, shareHubsLoading: false };
    case "closeShare":
      return {
        ...state,
        shareTarget: null,
        shareSubView: "chooser",
        shareBusy: false,
        shareUrl: null,
        shareError: null,
        shareTeamBusy: false,
        shareTeamError: null,
        shareTeamSuccess: null,
        sharePermissionChoice: "org",
        shareHubsError: null,
        shareManageableHubs: [],
      };
    case "openShare":
      return {
        ...state,
        shareTarget: action.skill,
        shareSubView: "chooser",
        shareBusy: false,
        shareUrl: null,
        shareError: null,
        shareTeamBusy: false,
        shareTeamError: null,
        shareTeamSuccess: null,
        sharePermissionChoice: "org",
        shareHubsError: null,
        shareManageableHubs: [],
        cloudSessionNonce: state.cloudSessionNonce + 1,
      };
  }
}

export function SkillsView(props: SkillsViewProps) {
  const { extensions } = props;
  const [localState, dispatchLocal] = useReducer(
    skillsViewLocalReducer,
    initialSkillsViewLocalState,
  );
  const {
    uninstallTarget,
    searchQuery,
    activeFilter,
    customRepoOpen,
    customRepoOwner,
    customRepoName,
    customRepoRef,
    customRepoError,
    shareTarget,
    shareSubView,
    shareBusy,
    shareUrl,
    shareError,
    cloudSessionNonce,
    shareTeamBusy,
    shareTeamError,
    shareTeamSuccess,
    sharePermissionChoice,
    shareHubsLoading,
    shareHubsError,
    shareManageableHubs,
    selectedSkill,
    selectedContent,
    selectedLoading,
    selectedDirty,
    selectedError,
    installingSkillCreator,
    installingHubSkill,
    installingCloudSkillId,
    denUiTick,
  } = localState;
  const setLocal = <K extends keyof SkillsViewLocalState>(
    key: K,
    value: SetStateAction<SkillsViewLocalState[K]>,
  ) => dispatchLocal({ type: "set", key, value });
  const setUninstallTarget = (value: SetStateAction<SkillCard | null>) => setLocal("uninstallTarget", value);
  const setSearchQuery = (value: SetStateAction<string>) => setLocal("searchQuery", value);
  const setActiveFilter = (value: SetStateAction<SkillsFilter>) => setLocal("activeFilter", value);
  const setCustomRepoOpen = (value: SetStateAction<boolean>) => setLocal("customRepoOpen", value);
  const setCustomRepoOwner = (value: SetStateAction<string>) => setLocal("customRepoOwner", value);
  const setCustomRepoName = (value: SetStateAction<string>) => setLocal("customRepoName", value);
  const setCustomRepoRef = (value: SetStateAction<string>) => setLocal("customRepoRef", value);
  const setCustomRepoError = (value: SetStateAction<string | null>) => setLocal("customRepoError", value);
  const setShareTarget = (value: SetStateAction<SkillCard | null>) => setLocal("shareTarget", value);
  const setShareSubView = (value: SetStateAction<ShareSkillSubView>) => setLocal("shareSubView", value);
  const setShareBusy = (value: SetStateAction<boolean>) => setLocal("shareBusy", value);
  const setShareUrl = (value: SetStateAction<string | null>) => setLocal("shareUrl", value);
  const setShareError = (value: SetStateAction<string | null>) => setLocal("shareError", value);
  const setShareTeamBusy = (value: SetStateAction<boolean>) => setLocal("shareTeamBusy", value);
  const setShareTeamError = (value: SetStateAction<string | null>) => setLocal("shareTeamError", value);
  const setShareTeamSuccess = (value: SetStateAction<string | null>) => setLocal("shareTeamSuccess", value);
  const setSharePermissionChoice = (value: SetStateAction<string>) => setLocal("sharePermissionChoice", value);
  const setSelectedSkill = (value: SetStateAction<SkillCard | null>) => setLocal("selectedSkill", value);
  const setSelectedContent = (value: SetStateAction<string>) => setLocal("selectedContent", value);
  const setSelectedLoading = (value: SetStateAction<boolean>) => setLocal("selectedLoading", value);
  const setSelectedDirty = (value: SetStateAction<boolean>) => setLocal("selectedDirty", value);
  const setSelectedError = (value: SetStateAction<string | null>) => setLocal("selectedError", value);
  const setInstallingSkillCreator = (value: SetStateAction<boolean>) => setLocal("installingSkillCreator", value);
  const setInstallingHubSkill = (value: SetStateAction<string | null>) => setLocal("installingHubSkill", value);
  const setInstallingCloudSkillId = (value: SetStateAction<string | null>) => setLocal("installingCloudSkillId", value);

  const showToast = useCallback(
    (title: string, tone: ToastTone = "info") => {
      props.onToast?.({ title, tone });
    },
    [props],
  );

  const maskError = useCallback(
    (value: unknown) =>
      value instanceof Error ? value.message : t("common.something_went_wrong"),
    [],
  );

  useEffect(() => {
    void extensions.ensureHubSkillsFresh();
    void extensions.ensureCloudOrgSkillsFresh();
    const onDenSession = () => {
      dispatchLocal({ type: "denSessionUpdated" });
      void extensions.refreshCloudOrgSkills({ force: true });
    };
    window.addEventListener("openwork-den-session-updated", onDenSession);
    return () => window.removeEventListener("openwork-den-session-updated", onDenSession);
  }, [extensions]);

  useEffect(() => {
    if (!shareTarget) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (shareSubView !== "chooser") {
        dispatchLocal({ type: "resetShareChooser" });
        return;
      }
      setShareTarget(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shareSubView, shareTarget]);

  const shareCloudSignedIn = useMemo(() => {
    cloudSessionNonce;
    return Boolean(readDenSettings().authToken?.trim());
  }, [cloudSessionNonce]);

  const shareTeamOrgLabel = useMemo(() => {
    cloudSessionNonce;
    const name = readDenSettings().activeOrgName?.trim();
    return name || t("skills.share_team_org_fallback");
  }, [cloudSessionNonce]);

  const shareTeamDisabledReason = useMemo(() => {
    if (!shareCloudSignedIn) return null;
    const settings = readDenSettings();
    if (!settings.activeOrgId?.trim() && !settings.activeOrgSlug?.trim()) {
      return t("skills.share_team_choose_org");
    }
    return null;
  }, [shareCloudSignedIn]);

  useEffect(() => {
    if (!shareTarget || shareSubView !== "team" || !shareCloudSignedIn) return;

    let cancelled = false;
    void (async () => {
      dispatchLocal({ type: "shareHubsStart" });
      try {
        const settings = readDenSettings();
        const token = settings.authToken?.trim() ?? "";
        if (!token) return;

        let orgId = settings.activeOrgId?.trim() ?? "";
        const client = createDenClient({ baseUrl: settings.baseUrl, token });
        if (!orgId) {
          const result = await client.listOrgs();
          orgId = result.orgs[0]?.id ?? "";
        }
        if (!orgId) {
          throw new Error(t("skills.share_team_choose_org"));
        }
        const hubs = await client.listOrgSkillHubSummaries(orgId);
        if (cancelled) return;
        dispatchLocal({ type: "shareHubsLoaded", hubs: hubs.filter((hub) => hub.canManage) });
      } catch (error) {
        if (cancelled) return;
        dispatchLocal({ type: "shareHubsFailed", error: maskError(error) });
      } finally {
        if (!cancelled) dispatchLocal({ type: "shareHubsDone" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [maskError, shareCloudSignedIn, shareSubView, shareTarget]);

  const skills = extensions.skills();
  const hubSkills = extensions.hubSkills();
  const cloudOrgSkills = extensions.cloudOrgSkills();
  const importedCloudSkills = extensions.importedCloudSkills();
  const hubRepo = extensions.hubRepo();
  const hubRepos = extensions.hubRepos();
  const skillsStatus = extensions.skillsStatus();
  const hubSkillsStatus = extensions.hubSkillsStatus();
  const cloudOrgSkillsStatus = extensions.cloudOrgSkillsStatus();

  const skillCreatorInstalled = useMemo(
    () => skills.some((skill) => skill.name === "skill-creator"),
    [skills],
  );

  const filteredSkills = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter((skill) => {
      const description = skill.description ?? "";
      return skill.name.toLowerCase().includes(query) || description.toLowerCase().includes(query);
    });
  }, [searchQuery, skills]);

  const installedNames = useMemo(() => new Set(skills.map((skill) => skill.name)), [skills]);

  const filteredHubSkills = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const items = hubSkills.filter((skill) => !installedNames.has(skill.name));
    if (!query) return items;
    return items.filter((skill) => {
      const description = skill.description ?? "";
      const trigger = skill.trigger ?? "";
      return (
        skill.name.toLowerCase().includes(query) ||
        description.toLowerCase().includes(query) ||
        trigger.toLowerCase().includes(query)
      );
    });
  }, [hubSkills, installedNames, searchQuery]);

  const filteredCloudOrgSkills = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return cloudOrgSkills;
    return cloudOrgSkills.filter((skill) => {
      const description = skill.description ?? "";
      const hub = skill.hubName ?? "";
      return (
        skill.title.toLowerCase().includes(query) ||
        description.toLowerCase().includes(query) ||
        hub.toLowerCase().includes(query)
      );
    });
  }, [cloudOrgSkills, searchQuery]);

  const cloudSkillInstallState = useCallback(
    (skill: DenOrgSkillCard): CloudSkillInstallState => {
      const imported = importedCloudSkills[skill.id];
      if (!imported) return "available";
      if (!installedNames.has(imported.installedName)) return "missing_local";

      const remoteUpdatedAt = skill.updatedAt ? Date.parse(skill.updatedAt) : Number.NaN;
      const importedUpdatedAt = imported.updatedAt ? Date.parse(imported.updatedAt) : Number.NaN;
      if (
        Number.isFinite(remoteUpdatedAt) &&
        (!Number.isFinite(importedUpdatedAt) || remoteUpdatedAt > importedUpdatedAt)
      ) {
        return "update";
      }
      return "installed";
    },
    [importedCloudSkills, installedNames],
  );

  const cloudOrgLabel = useMemo(() => {
    denUiTick;
    const name = readDenSettings().activeOrgName?.trim();
    return name || t("skills.cloud_org_fallback");
  }, [denUiTick]);

  const cloudSessionReady = useMemo(() => {
    denUiTick;
    const settings = readDenSettings();
    return Boolean(settings.authToken?.trim() && settings.activeOrgId?.trim());
  }, [denUiTick]);

  const cloudNeedsSignIn = useMemo(() => {
    denUiTick;
    return !readDenSettings().authToken?.trim();
  }, [denUiTick]);

  const sharePermissionOptions = useMemo<SelectMenuOption[]>(
    () => [
      { value: "private", label: t("skills.share_team_permission_private") },
      { value: "org", label: t("skills.share_team_permission_org") },
      ...shareManageableHubs.map((hub) => ({ value: hub.id, label: hub.name })),
    ],
    [shareManageableHubs],
  );

  const shareModalSubtitle = useMemo(() => {
    switch (shareSubView) {
      case "public":
        return t("skills.share_subtitle_public");
      case "team":
        return t("skills.share_subtitle_team");
      default:
        return t("skills.share_chooser_subtitle");
    }
  }, [shareSubView]);

  const activeHubRepoLabel = useMemo(
    () => (hubRepo ? `${hubRepo.owner}/${hubRepo.repo}@${hubRepo.ref}` : t("skills.no_hub_repo_label")),
    [hubRepo],
  );

  const hasDefaultHubRepo = useMemo(
    () => hubRepos.some((repo) => `${repo.owner}/${repo.repo}@${repo.ref}` === "different-ai/openwork-hub@main"),
    [hubRepos],
  );

  const showInstalledSection = activeFilter === "all" || activeFilter === "installed";
  const showCloudSection = activeFilter === "all" || activeFilter === "cloud";
  const showHubSection = activeFilter === "all" || activeFilter === "hub";
  const canCreateInChat = !props.busy && (props.canInstallSkillCreator || props.canUseDesktopTools);

  const resolveSharePermission = () => {
    const choice = sharePermissionChoice.trim();
    if (!choice || choice === "org") return { shared: "org" as const, hubId: null as string | null };
    if (choice === "private") return { shared: null, hubId: null as string | null };
    return { shared: null, hubId: choice };
  };

  const closeShareLink = useCallback(() => {
    dispatchLocal({ type: "closeShare" });
  }, []);

  const goBackShareSubView = useCallback(() => {
    dispatchLocal({ type: "resetShareChooser" });
  }, []);

  const runDesktopAction = useCallback(
    (action: () => void | Promise<void>) => {
      if (props.busy) return;
      if (!props.canUseDesktopTools) {
        showToast(t("skills.desktop_required"), "warning");
        return;
      }
      void Promise.resolve(action());
    },
    [props.busy, props.canUseDesktopTools, showToast],
  );

  const refreshCatalogs = useCallback(() => {
    if (props.busy) return;
    void extensions.refreshSkills({ force: true });
    void extensions.refreshHubSkills({ force: true });
    void extensions.refreshCloudOrgSkills({ force: true });
  }, [extensions, props.busy]);

  const installSkillCreator = useCallback(async () => {
    if (props.busy || installingSkillCreator) return;
    if (!props.canInstallSkillCreator) {
      showToast(props.accessHint ?? t("skills.host_only_error"), "warning");
      return;
    }
    setInstallingSkillCreator(true);
    showToast(t("skills.installing_skill_creator"));
    try {
      const result = await extensions.installSkillCreator();
      showToast(result.message, "success");
    } catch (error) {
      showToast(maskError(error), "error");
    } finally {
      setInstallingSkillCreator(false);
    }
  }, [extensions, installingSkillCreator, maskError, props.accessHint, props.busy, props.canInstallSkillCreator, showToast]);

  const installFromCloud = useCallback(
    async (skill: DenOrgSkillCard) => {
      if (props.busy || installingCloudSkillId) return;
      const state = cloudSkillInstallState(skill);
      if (state === "installed") return;
      setInstallingCloudSkillId(skill.id);
      showToast(
        t(state === "update" ? "skills.cloud_updating" : "skills.cloud_installing", undefined, { title: skill.title }),
      );
      try {
        const result = await extensions.installCloudOrgSkill(skill);
        showToast(result.message, result.ok ? "success" : "error");
      } catch (error) {
        showToast(maskError(error), "error");
      } finally {
        setInstallingCloudSkillId(null);
      }
    },
    [cloudSkillInstallState, extensions, installingCloudSkillId, maskError, props.busy, showToast],
  );

  const installFromHub = useCallback(
    async (skill: HubSkillCard) => {
      if (props.busy || installingHubSkill) return;
      setInstallingHubSkill(skill.name);
      showToast(`${t("skills.installing_prefix")} ${skill.name}...`);
      try {
        const result = await extensions.installHubSkill(skill.name);
        showToast(result.message, "success");
      } catch (error) {
        showToast(maskError(error), "error");
      } finally {
        setInstallingHubSkill(null);
      }
    },
    [extensions, installingHubSkill, maskError, props.busy, showToast],
  );

  const handleNewSkill = useCallback(async () => {
    if (props.busy) return;
    if (props.canInstallSkillCreator && !skillCreatorInstalled) {
      await installSkillCreator();
    }
    await Promise.resolve(props.createSessionAndOpen("/skill-creator"));
  }, [installSkillCreator, props, skillCreatorInstalled]);

  const openCloudSignIn = useCallback(() => {
    const base = readDenSettings().baseUrl?.trim() || DEFAULT_DEN_BASE_URL;
    props.onOpenLink(buildDenAuthUrl(base, "sign-in"));
  }, [props]);

  const openShareLink = useCallback(
    (skill: SkillCard) => {
      if (props.busy) return;
      dispatchLocal({ type: "openShare", skill });
    },
    [props.busy],
  );

  const startShareSkillSignIn = useCallback(() => {
    const settings = readDenSettings();
    props.onOpenLink(buildDenAuthUrl(settings.baseUrl, "sign-in"));
  }, [props]);

  const publishSkillToTeam = useCallback(async () => {
    if (!shareTarget || props.busy || shareTeamBusy || shareTeamDisabledReason) return;
    setShareTeamBusy(true);
    setShareTeamError(null);
    setShareTeamSuccess(null);
    try {
      const skill = await extensions.readSkill(shareTarget.name);
      if (!skill) throw new Error("Failed to load skill");
      const sharing = resolveSharePermission();
      const { orgName, orgId } = await saveInstalledSkillToOpenWorkOrg({
        skillText: skill.content,
        shared: sharing.shared,
        skillHubId: sharing.hubId,
      });
      setShareTeamSuccess(t("skills.share_team_uploaded_success", undefined, { org: orgName }));
      window.dispatchEvent(
        new CustomEvent<{ orgId: string }>("openwork-den-org-skills-changed", {
          detail: { orgId },
        }),
      );
      void extensions.refreshCloudOrgSkills({ force: true });
    } catch (error) {
      setShareTeamError(maskError(error));
    } finally {
      setShareTeamBusy(false);
    }
  }, [extensions, maskError, props.busy, shareTarget, shareTeamBusy, shareTeamDisabledReason]);

  const publishShareLink = useCallback(async () => {
    if (!shareTarget || props.busy || shareBusy) return;
    setShareBusy(true);
    setShareUrl(null);
    setShareError(null);
    try {
      const skill = await extensions.readSkill(shareTarget.name);
      if (!skill) throw new Error(t("skills.skill_load_failed"));
      const payload: SkillBundleV1 = {
        schemaVersion: 1,
        type: "skill",
        name: shareTarget.name,
        content: skill.content,
        description: shareTarget.description ?? undefined,
        trigger: shareTarget.trigger ?? undefined,
      };
      const result = await publishOpenworkBundleJson({
        payload,
        bundleType: "skill",
        name: shareTarget.name,
      });
      setShareUrl(result.url);
      try {
        await navigator.clipboard.writeText(result.url);
        showToast(t("skills.link_copied"), "success");
      } catch {
        // ignore clipboard failures
      }
    } catch (error) {
      setShareError(maskError(error));
    } finally {
      setShareBusy(false);
    }
  }, [extensions, maskError, props.busy, shareBusy, shareTarget, showToast]);

  const copyShareLink = useCallback(async () => {
    const url = shareUrl?.trim();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      showToast(t("skills.link_copied"), "success");
    } catch {
      setShareError(t("skills.copy_link_failed"));
    }
  }, [shareUrl, showToast]);

  const openSkill = useCallback(
    async (skill: SkillCard) => {
      if (props.busy) return;
      setSelectedSkill(skill);
      setSelectedContent("");
      setSelectedDirty(false);
      setSelectedError(null);
      setSelectedLoading(true);
      try {
        const result = await extensions.readSkill(skill.name);
        if (!result) {
          setSelectedError(t("skills.skill_load_failed"));
          return;
        }
        setSelectedContent(result.content);
      } catch (error) {
        setSelectedError(maskError(error));
      } finally {
        setSelectedLoading(false);
      }
    },
    [extensions, maskError, props.busy],
  );

  const saveSelectedSkill = useCallback(async () => {
    if (!selectedSkill || !selectedDirty) return;
    setSelectedError(null);
    try {
      await Promise.resolve(
        extensions.saveSkill({
          name: selectedSkill.name,
          content: selectedContent,
          description: selectedSkill.description,
        }),
      );
      setSelectedDirty(false);
    } catch (error) {
      setSelectedError(maskError(error));
    }
  }, [extensions, maskError, selectedContent, selectedDirty, selectedSkill]);

  const selectHubRepo = useCallback(
    (repo: HubSkillRepo) => {
      void Promise.resolve(extensions.setHubRepo(repo)).then(() => {
        void extensions.refreshHubSkills({ force: true });
      });
    },
    [extensions],
  );

  const openCustomRepoModal = useCallback(() => {
    if (props.busy) return;
    setCustomRepoOpen(true);
    setCustomRepoOwner(hubRepo?.owner ?? "");
    setCustomRepoName(hubRepo?.repo ?? "");
    setCustomRepoRef(hubRepo?.ref || "main");
    setCustomRepoError(null);
  }, [hubRepo, props.busy]);

  const closeCustomRepoModal = useCallback(() => {
    setCustomRepoOpen(false);
    setCustomRepoError(null);
  }, []);

  const saveCustomRepo = useCallback(() => {
    const owner = customRepoOwner.trim();
    const repo = customRepoName.trim();
    const ref = customRepoRef.trim() || "main";
    if (!owner || !repo) {
      setCustomRepoError(t("skills.owner_repo_required"));
      return;
    }
    void Promise.resolve(extensions.addHubRepo({ owner, repo, ref })).then(() => {
      void extensions.refreshHubSkills({ force: true });
    });
    closeCustomRepoModal();
  }, [closeCustomRepoModal, customRepoName, customRepoOwner, customRepoRef, extensions]);

  const isOpenworkInjectedSkill = (skill: SkillCard) => {
    const normalizedName = skill.name.trim().toLowerCase();
    const normalizedPath = skill.path.replace(/\\/g, "/").toLowerCase();
    return normalizedPath.includes("/.opencode/skills/") &&
      (OPENWORK_DEFAULT_SKILL_NAMES.has(normalizedName) || normalizedName.endsWith("-creator"));
  };

  const handleSkillCardKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    skill: SkillCard,
  ) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    void openSkill(skill);
  };

  return (
    <section className="space-y-8 max-w-3xl w-full">
      <div className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            {props.showHeader !== false ? <h2 className={pageTitleClass}>{t("skills.title")}</h2> : null}
            <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-dls-secondary">
              {t("skills.worker_profile_desc")}
            </p>
          </div>

          <div className="flex flex-wrap gap-3 lg:justify-end">
            <button
              type="button"
              onClick={() => runDesktopAction(extensions.importLocalSkill)}
              disabled={props.busy || !props.canUseDesktopTools}
              className={pillSecondaryClass}
            >
              <Upload size={14} />
              {t("skills.import_local_skill")}
            </button>
            <button
              type="button"
              onClick={() => runDesktopAction(extensions.revealSkillsFolder)}
              disabled={props.busy || !props.canUseDesktopTools}
              className={pillSecondaryClass}
            >
              <FolderOpen size={14} />
              {t("skills.reveal_folder")}
            </button>
            <button type="button" onClick={() => void handleNewSkill()} disabled={!canCreateInChat} className={pillPrimaryClass}>
              <Sparkles size={14} />
              {t("skills.create_in_chat")}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-[20px] border border-dls-border bg-dls-surface p-4 md:flex-row md:items-center md:justify-between">
          <div className="relative min-w-0 flex-1">
            <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-dls-secondary" />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              placeholder={t("skills.catalog_search_placeholder")}
              className="w-full rounded-xl border border-dls-border bg-dls-surface py-3 pl-11 pr-4 text-[14px] text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.12)]"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(["all", "installed", "cloud", "hub"] as SkillsFilter[]).map((filter) => (
              <button
                key={filter}
                type="button"
                onClick={() => setActiveFilter(filter)}
                className={activeFilter === filter ? pillPrimaryClass : pillGhostClass}
              >
                {filter === "all"
                  ? t("skills.filter_all")
                  : filter === "installed"
                    ? t("skills.filter_installed")
                    : filter === "cloud"
                      ? t("skills.filter_cloud")
                      : t("skills.filter_hub")}
              </button>
            ))}
            <button type="button" onClick={refreshCatalogs} disabled={props.busy} className={pillSecondaryClass}>
              <RefreshCw size={14} />
              {t("common.refresh")}
            </button>
          </div>
        </div>
      </div>

      {props.accessHint ? (
        <div className="rounded-[20px] border border-dls-border bg-dls-hover px-5 py-4 text-[13px] text-dls-secondary">
          {props.accessHint}
        </div>
      ) : null}
      {!props.accessHint && !props.canInstallSkillCreator && !props.canUseDesktopTools ? (
        <div className="rounded-[20px] border border-dls-border bg-dls-hover px-5 py-4 text-[13px] text-dls-secondary">
          {t("skills.host_mode_only")}
        </div>
      ) : null}

      {skillsStatus ? (
        <div className="whitespace-pre-wrap break-words rounded-[20px] border border-dls-border bg-dls-hover px-5 py-4 text-[13px] text-dls-secondary">
          {skillsStatus}
        </div>
      ) : null}

      {showInstalledSection ? (
        <div className="space-y-4">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h3 className={sectionTitleClass}>{t("skills.installed")}</h3>
              <p className="mt-1 text-[13px] text-dls-secondary">{t("skills.installed_desc")}</p>
            </div>
            <div className="text-[12px] text-dls-secondary">{t("skills.shown_count", undefined, { count: filteredSkills.length })}</div>
          </div>

          {filteredSkills.length === 0 ? (
            <div className="rounded-[20px] border border-dashed border-dls-border bg-dls-surface px-5 py-8 text-[14px] text-dls-secondary">
              {t("skills.no_skills")}
            </div>
          ) : (
            <div className="rounded-[24px] bg-dls-hover p-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {filteredSkills.map((skill) => (
                  <div
                    key={skill.path}
                    role="button"
                    tabIndex={0}
                    className={`${panelCardClass} flex cursor-pointer flex-col gap-4 text-left`}
                    onClick={() => void openSkill(skill)}
                    onKeyDown={(event) => handleSkillCardKeyDown(event, skill)}
                  >
                    <div className="flex min-w-0 gap-4">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
                        <Package size={20} className="text-dls-secondary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="truncate text-[14px] font-semibold text-dls-text">{skill.name}</h4>
                          {isOpenworkInjectedSkill(skill) ? <span className={tagClass}>OpenWork</span> : null}
                        </div>
                        <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-dls-secondary">
                          {skill.description || t("skills.no_description")}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-dls-border pt-4">
                      <span className={tagClass}>{t("skills.installed_status")}</span>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className={pillGhostClass}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            openShareLink(skill);
                          }}
                          disabled={props.busy}
                          title={t("skills.share_title")}
                        >
                          <Share2 size={14} />
                          {t("skills.share_title")}
                        </button>
                        <button
                          type="button"
                          className={pillSecondaryClass}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void openSkill(skill);
                          }}
                          disabled={props.busy}
                          title={t("common.edit")}
                        >
                          <Edit2 size={14} />
                          {t("common.edit")}
                        </button>
                        <button
                          type="button"
                          className={pillGhostClass}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (props.busy || !props.canUseDesktopTools) {
                              if (!props.canUseDesktopTools) showToast(t("skills.desktop_required"), "warning");
                              return;
                            }
                            setUninstallTarget(skill);
                          }}
                          disabled={props.busy || !props.canUseDesktopTools}
                          title={t("skills.uninstall")}
                        >
                          <Trash2 size={14} />
                          {t("common.remove")}
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}

      {showCloudSection ? (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="mb-0.5 text-[12px] text-dls-secondary">{cloudOrgLabel}</p>
              <h3 className={sectionTitleClass}>{t("skills.cloud_section_title")}</h3>
              <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-dls-secondary">
                {t("skills.cloud_section_subtitle")}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void extensions.refreshCloudOrgSkills({ force: true })}
                disabled={props.busy}
                className={pillSecondaryClass}
              >
                <RefreshCw size={14} />
                {t("skills.cloud_refresh")}
              </button>
            </div>
          </div>

          {!cloudSessionReady ? (
            <div className="rounded-[20px] border border-dashed border-dls-border bg-dls-surface px-5 py-6 text-[14px] text-dls-secondary">
              {cloudNeedsSignIn ? (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p>{t("skills.cloud_sign_in_hint")}</p>
                  <button type="button" className={pillPrimaryClass} onClick={openCloudSignIn}>
                    {t("skills.cloud_sign_in")}
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <p>{t("skills.cloud_choose_org_hint")}</p>
                  <p className="text-[13px]">{t("skills.cloud_choose_org_detail")}</p>
                </div>
              )}
            </div>
          ) : (
            <>
              {cloudOrgSkillsStatus ? (
                <div className="whitespace-pre-wrap break-words rounded-[20px] border border-dls-border bg-dls-hover px-5 py-4 text-[13px] text-dls-secondary">
                  {cloudOrgSkillsStatus}
                </div>
              ) : null}

              {filteredCloudOrgSkills.length === 0 ? (
                <div className="rounded-[20px] border border-dashed border-dls-border bg-dls-surface px-5 py-8 text-[14px] text-dls-secondary">
                  {cloudOrgSkills.length === 0 ? t("skills.cloud_org_empty") : t("skills.cloud_no_search_matches")}
                </div>
              ) : (
                <div className="rounded-[24px] bg-dls-hover p-4">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {filteredCloudOrgSkills.map((skill) => {
                      const state = cloudSkillInstallState(skill);
                      const installedName = importedCloudSkills[skill.id]?.installedName ?? null;
                      return (
                        <div key={skill.id} className={`${panelCardClass} flex flex-col gap-4 text-left`}>
                          <div className="flex min-w-0 gap-4">
                            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
                              <Cloud size={20} className="text-dls-secondary" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <h4 className="truncate text-[14px] font-semibold text-dls-text">{skill.title}</h4>
                              {skill.description ? (
                                <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-dls-secondary">{skill.description}</p>
                              ) : null}
                              <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-dls-secondary">
                                {skill.hubName ? <span className={tagClass}>{t("skills.cloud_hub_label", undefined, { name: skill.hubName })}</span> : null}
                                {skill.shared === "org" ? <span className={tagClass}>{t("skills.cloud_shared_org")}</span> : null}
                                {skill.shared === "public" ? <span className={tagClass}>{t("skills.cloud_shared_public")}</span> : null}
                                {skill.shared === null && !skill.hubName ? <span className={tagClass}>{t("skills.cloud_shared_private")}</span> : null}
                                {installedName ? <span className={tagClass}>{t("skills.cloud_installed_as", undefined, { name: installedName })}</span> : null}
                                {state === "installed" ? <span className={tagClass}>{t("skills.cloud_status_installed")}</span> : null}
                                {state === "update" ? <span className={tagClass}>{t("skills.cloud_status_update")}</span> : null}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center justify-between gap-3 border-t border-dls-border pt-4">
                            <span className={tagClass}>{t("skills.cloud_footer_label")}</span>
                            <button
                              type="button"
                              className={installingCloudSkillId === skill.id || state === "installed" ? pillSecondaryClass : pillPrimaryClass}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                void installFromCloud(skill);
                              }}
                              disabled={props.busy || installingCloudSkillId === skill.id || state === "installed"}
                            >
                              {installingCloudSkillId === skill.id ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                              {installingCloudSkillId === skill.id
                                ? t("skills.cloud_installing_short")
                                : state === "update"
                                  ? t("skills.cloud_update_skill")
                                  : state === "installed"
                                    ? t("skills.cloud_status_installed")
                                    : t("skills.install")}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      ) : null}

      {showHubSection ? (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h3 className={sectionTitleClass}>{t("skills.available_from_hub")}</h3>
              <p className="mt-1 text-[13px] text-dls-secondary">{t("skills.hub_desc")}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  void Promise.resolve(extensions.addHubRepo({ owner: "different-ai", repo: "openwork-hub", ref: "main" })).then(() => {
                    void extensions.refreshHubSkills({ force: true });
                  });
                }}
                className={pillGhostClass}
                disabled={props.busy || hasDefaultHubRepo}
              >
                <Plus size={14} />
                {t("skills.add_openwork_hub")}
              </button>
              <button type="button" onClick={openCustomRepoModal} disabled={props.busy} className={pillSecondaryClass}>
                <Plus size={14} />
                {t("skills.add_git_repo")}
              </button>
              <button
                type="button"
                onClick={() => void extensions.refreshHubSkills({ force: true })}
                disabled={props.busy}
                className={pillSecondaryClass}
              >
                <RefreshCw size={14} />
                {t("skills.refresh_hub")}
              </button>
            </div>
          </div>

          <div className="space-y-3 rounded-[20px] border border-dls-border bg-dls-surface p-4">
            <div className="text-[12px] text-dls-secondary">
              {t("skills.source_label")}: <span className="font-mono text-dls-text">{activeHubRepoLabel}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {hubRepos.map((repo) => {
                const key = `${repo.owner}/${repo.repo}@${repo.ref}`;
                const active = hubRepo ? key === `${hubRepo.owner}/${hubRepo.repo}@${hubRepo.ref}` : false;
                return (
                  <div key={key} className="inline-flex items-center overflow-hidden rounded-full border border-dls-border bg-dls-surface">
                    <button
                      type="button"
                      onClick={() => selectHubRepo(repo)}
                      className={`px-3 py-1.5 text-[12px] font-medium transition-colors ${
                        active ? "bg-dls-accent text-[var(--dls-accent-fg)]" : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
                      }`}
                      disabled={props.busy}
                    >
                      {key}
                    </button>
                    <button
                      type="button"
                      className="px-2 py-1.5 text-[12px] text-dls-secondary transition-colors hover:bg-dls-hover hover:text-red-11"
                      onClick={() => {
                        void Promise.resolve(extensions.removeHubRepo(repo)).then(() => {
                          void extensions.refreshHubSkills({ force: true });
                        });
                      }}
                      disabled={props.busy}
                      title={t("skills.remove_saved_repo")}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {hubSkillsStatus ? (
            <div className="whitespace-pre-wrap break-words rounded-[20px] border border-dls-border bg-dls-hover px-5 py-4 text-[13px] text-dls-secondary">
              {hubSkillsStatus}
            </div>
          ) : null}

          {filteredHubSkills.length === 0 ? (
            <div className="rounded-[20px] border border-dashed border-dls-border bg-dls-surface px-5 py-8 text-[14px] text-dls-secondary">
              {hubRepo ? t("skills.no_hub_skills") : t("skills.no_hub_repo_selected")}
            </div>
          ) : (
            <div className="rounded-[24px] bg-dls-hover p-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {filteredHubSkills.map((skill) => (
                  <div key={`${skill.source.owner}/${skill.source.repo}/${skill.name}`} className={`${panelCardClass} flex flex-col gap-4 text-left`}>
                    <div className="flex min-w-0 gap-4">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
                        <Package size={20} className="text-dls-secondary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h4 className="truncate text-[14px] font-semibold text-dls-text">{skill.name}</h4>
                        <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-dls-secondary">
                          {skill.description || t("skills.from_repo", undefined, { owner: skill.source.owner, repo: skill.source.repo })}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-dls-secondary">
                          <span className={`${tagClass} font-mono`}>{skill.source.owner}/{skill.source.repo}</span>
                          {skill.trigger ? (
                            <span className={tagClass} title={t("skills.trigger_label", undefined, { trigger: skill.trigger })}>
                              {t("skills.trigger_label", undefined, { trigger: skill.trigger })}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 border-t border-dls-border pt-4">
                      <span className={tagClass}>{t("skills.hub_label")}</span>
                      <button
                        type="button"
                        className={installingHubSkill === skill.name ? pillSecondaryClass : pillPrimaryClass}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void installFromHub(skill);
                        }}
                        disabled={props.busy || installingHubSkill === skill.name}
                        title={t("skills.install_name_title", undefined, { name: skill.name })}
                      >
                        {installingHubSkill === skill.name ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                        {installingHubSkill === skill.name ? t("skills.installing") : t("common.add")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}

      <Dialog
        open={Boolean(selectedSkill)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedSkill(null);
            setSelectedContent("");
            setSelectedDirty(false);
            setSelectedError(null);
            setSelectedLoading(false);
          }
        }}
      >
        <DialogContent className="flex max-h-[90vh] min-h-0 w-full max-w-4xl flex-col overflow-hidden sm:max-w-4xl">
            <DialogHeader>
              <div className="flex min-w-0 items-center gap-3">
                <DialogTitle className="min-w-0 flex-1 truncate">{selectedSkill?.name}</DialogTitle>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    disabled={!selectedDirty || props.busy}
                    onClick={() => void saveSelectedSkill()}
                  >
                    {t("common.save")}
                  </Button>
                </div>
              </div>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {selectedError ? <div className="mb-3 rounded-xl border border-red-7/20 bg-red-1/40 px-4 py-3 text-xs text-red-12">{selectedError}</div> : null}
              {selectedLoading ? (
                <div className="text-xs text-dls-secondary">{t("skills.loading")}</div>
              ) : (
                <textarea
                  value={selectedContent}
                  onChange={(event) => {
                    setSelectedContent(event.currentTarget.value);
                    setSelectedDirty(true);
                  }}
                  className="min-h-[420px] w-full rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-xs font-mono text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.25)]"
                  spellCheck={false}
                />
              )}
            </div>
        </DialogContent>
      </Dialog>

      <ConfirmModal
        open={Boolean(uninstallTarget)}
        title={t("skills.uninstall_title")}
        message={t("skills.uninstall_warning").replace("{name}", uninstallTarget?.name ?? "")}
        confirmLabel={t("skills.uninstall")}
        cancelLabel={t("common.cancel")}
        confirmButtonVariant="destructive"
        onCancel={() => setUninstallTarget(null)}
        onConfirm={() => {
          const target = uninstallTarget;
          setUninstallTarget(null);
          if (!target) return;
          void extensions.uninstallSkill(target.name);
        }}
      />

      <Dialog
        open={Boolean(shareTarget)}
        onOpenChange={(open) => {
          if (!open) closeShareLink();
        }}
      >
        <DialogContent className="flex max-h-[78vh] min-h-0 w-full max-w-md flex-col overflow-hidden sm:max-w-md">
          <DialogHeader className="flex-row">
            {shareSubView !== "chooser" ? (
              <Button
                onClick={goBackShareSubView}
                variant="ghost"
                size="icon"
                aria-label={t("skills.share_back")}
              >
                <ArrowLeft className="size-4" />
              </Button>
            ) : null}
            <div className="min-w-0 flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle>{t("skills.share_title")}</DialogTitle>
                {shareSubView === "chooser" ? (
                  <span className={tagClass}>{shareTarget?.name}</span>
                ) : null}
              </div>
              <DialogDescription>{shareModalSubtitle}</DialogDescription>
            </div>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto">
              {shareSubView === "chooser" ? (
                <div className="animate-in space-y-4 fade-in slide-in-from-bottom-3 duration-300">
                  <WorkspaceOptionCard
                    title={t("skills.share_option_team_title")}
                    description={t("skills.share_option_team_desc")}
                    icon={Users}
                    onClick={() => setShareSubView("team")}
                  />
                  <WorkspaceOptionCard
                    title={t("skills.share_option_public_title")}
                    description={t("skills.share_option_public_desc")}
                    icon={Rocket}
                    onClick={() => setShareSubView("public")}
                  />
                </div>
              ) : null}

              {shareSubView === "public" ? (
                <div className="animate-in space-y-5 pt-2 fade-in slide-in-from-right-4 duration-300">
                  <p className="text-[14px] leading-relaxed text-dls-secondary">{t("skills.share_public_intro")}</p>
                  <div className={surfaceCardClass}>
                    <div className="mb-3 break-all font-mono text-[12px] text-dls-secondary">
                      {t("skills.share_publisher_label")}: {DEFAULT_OPENWORK_PUBLISHER_BASE_URL}
                    </div>
                    {shareError ? <div className={`mb-3 ${modalNoticeErrorClass}`}>{shareError}</div> : null}
                    {!shareUrl ? (
                      <button type="button" onClick={() => void publishShareLink()} disabled={shareBusy || props.busy} className={`${pillPrimaryClass} w-full`}>
                        {shareBusy ? t("skills.share_public_creating") : t("skills.share_public_create")}
                      </button>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <input type="text" readOnly value={shareUrl} className={`${inputClass} flex-1 font-mono text-[12px]`} />
                          <button type="button" onClick={() => void copyShareLink()} className={pillSecondaryClass}>
                            <Copy size={14} className="mr-1 inline" />
                            {t("skills.share_copy_link")}
                          </button>
                        </div>
                        <button type="button" onClick={() => void publishShareLink()} disabled={shareBusy} className={`${pillSecondaryClass} mt-3 w-full`}>
                          {shareBusy ? t("skills.share_public_creating") : t("skills.share_public_regenerate")}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ) : null}

              {shareSubView === "team" ? (
                <div className="animate-in space-y-5 pt-2 fade-in slide-in-from-right-4 duration-300">
                  <p className="text-[14px] leading-relaxed text-dls-secondary">{t("skills.share_team_permissions_intro")}</p>
                  <div className={surfaceCardClass}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={tagClass}>{shareTeamOrgLabel}</span>
                    </div>
                    {shareTeamError?.trim() ? <div className={`mt-4 ${modalNoticeErrorClass}`}>{shareTeamError}</div> : null}
                    {shareTeamSuccess?.trim() ? <div className={`mt-4 ${modalNoticeSuccessClass}`}>{shareTeamSuccess}</div> : null}
                    {shareHubsError?.trim() ? <div className={`mt-4 ${modalNoticeErrorClass}`}>{shareHubsError}</div> : null}
                    {shareCloudSignedIn && shareTeamDisabledReason?.trim() ? (
                      <div className="mt-4 text-[12px] text-dls-secondary">{shareTeamDisabledReason}</div>
                    ) : null}
                    {shareCloudSignedIn ? (
                      <div className="mt-4">
                        <span id="skills-share-hub-label" className="mb-1.5 block text-[13px] font-medium text-dls-text">
                          {t("skills.share_team_permissions_label")}
                        </span>
                        <SelectMenu
                          ariaLabelledBy="skills-share-hub-label"
                          options={sharePermissionOptions}
                          value={sharePermissionChoice}
                          onChange={setSharePermissionChoice}
                          disabled={shareTeamBusy || Boolean(shareTeamSuccess?.trim())}
                        />
                      </div>
                    ) : null}
                    {shareCloudSignedIn && shareHubsLoading ? (
                      <div className="mt-3 flex items-center gap-2 text-[12px] text-dls-secondary">
                        <Loader2 size={14} className="animate-spin" />
                        {t("skills.share_team_hubs_loading")}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        if (!shareCloudSignedIn) {
                          startShareSkillSignIn();
                          return;
                        }
                        void publishSkillToTeam();
                      }}
                      disabled={shareCloudSignedIn ? Boolean(shareTeamDisabledReason) || shareTeamBusy || Boolean(shareTeamSuccess?.trim()) : false}
                      className={`${pillPrimaryClass} mt-4 w-full`}
                    >
                      {!shareCloudSignedIn
                        ? t("skills.share_team_sign_in")
                        : shareTeamBusy
                          ? t("skills.share_team_uploading")
                          : t("skills.share_team_upload_and_save")}
                    </button>
                    {!shareCloudSignedIn ? <p className="mt-3 text-[12px] text-dls-secondary">{t("skills.share_team_sign_in_hint")}</p> : null}
                  </div>
                </div>
              ) : null}
            </div>
            {shareSubView === "public" ? (
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>
                  {t("skills.share_done")}
                </DialogClose>
              </DialogFooter>
            ) : null}
            {shareSubView === "team" ? (
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>
                  {t("skills.share_done")}
                </DialogClose>
              </DialogFooter>
            ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={customRepoOpen}
        onOpenChange={(open) => {
          if (!open) closeCustomRepoModal();
        }}
      >
        <DialogContent showCloseButton={false} className="w-full max-w-lg overflow-hidden sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{t("skills.add_custom_repo")}</DialogTitle>
              <DialogDescription>{t("skills.github_repo_hint")}</DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                  <div className="text-xs font-semibold uppercase tracking-widest text-dls-secondary">{t("skills.owner_label")}</div>
                  <input
                    type="text"
                    value={customRepoOwner}
                    onChange={(event) => setCustomRepoOwner(event.currentTarget.value)}
                    placeholder="different-ai"
                    className="w-full rounded-lg border border-dls-border bg-dls-hover px-3 py-2 text-xs font-mono text-dls-text focus:outline-none"
                    spellCheck={false}
                  />
                </label>
                <label className="space-y-1">
                  <div className="text-xs font-semibold uppercase tracking-widest text-dls-secondary">{t("skills.repo_label")}</div>
                  <input
                    type="text"
                    value={customRepoName}
                    onChange={(event) => setCustomRepoName(event.currentTarget.value)}
                    placeholder="openwork-hub"
                    className="w-full rounded-lg border border-dls-border bg-dls-hover px-3 py-2 text-xs font-mono text-dls-text focus:outline-none"
                    spellCheck={false}
                  />
                </label>
              </div>

              <label className="space-y-1">
                <div className="text-xs font-semibold uppercase tracking-widest text-dls-secondary">{t("skills.ref_label")}</div>
                <input
                  type="text"
                  value={customRepoRef}
                  onChange={(event) => setCustomRepoRef(event.currentTarget.value)}
                  placeholder="main"
                  className="w-full rounded-lg border border-dls-border bg-dls-hover px-3 py-2 text-xs font-mono text-dls-text focus:outline-none"
                  spellCheck={false}
                />
              </label>

              {customRepoError ? <div className="rounded-xl border border-red-7/20 bg-red-1/40 px-4 py-3 text-xs text-red-12">{customRepoError}</div> : null}
            </div>
            <DialogFooter>
              <DialogClose
                disabled={props.busy}
                render={<Button variant="outline" disabled={props.busy} />}
              >
                {t("common.cancel")}
              </DialogClose>
              <Button variant="secondary" onClick={saveCustomRepo} disabled={props.busy}>
                {t("skills.save_and_load")}
              </Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export default SkillsView;
