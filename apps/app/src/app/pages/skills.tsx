import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import type { DenOrgSkillCard, HubSkillCard, HubSkillRepo, SkillCard } from "../types";
import { useExtensions } from "../extensions/provider";
import { usePlatform } from "../context/platform";
import type { SkillBundleV1 } from "../bundles/types";
import { saveInstalledSkillToOpenWorkOrg } from "../bundles/skill-org-publish";

import Button from "../components/button";
import SelectMenu, { type SelectMenuOption } from "../components/select-menu";
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
  X,
} from "lucide-solid";
import { currentLocale, t } from "../../i18n";
import { DEFAULT_OPENWORK_PUBLISHER_BASE_URL, publishOpenworkBundleJson } from "../lib/publisher";
import { buildDenAuthUrl, createDenClient, DEFAULT_DEN_BASE_URL, readDenSettings, type DenOrgSkillHubSummary } from "../lib/den";
import { useStatusToasts, type AppStatusToastTone } from "../shell/status-toasts";
import WorkspaceOptionCard from "../workspace/option-card";
import {
  inputClass,
  modalHeaderButtonClass,
  modalHeaderClass,
  modalNoticeErrorClass,
  modalNoticeSuccessClass,
  modalOverlayClass,
  modalShellClass,
  modalSubtitleClass,
  modalTitleClass,
  pillPrimaryClass as sharePillPrimaryClass,
  pillSecondaryClass as sharePillSecondaryClass,
  surfaceCardClass,
  tagClass as shareTagClass,
} from "../workspace/modal-styles";

type InstallResult = { ok: boolean; message: string };
type SkillsFilter = "all" | "installed" | "cloud" | "hub";
type ShareSkillSubView = "chooser" | "public" | "team";

const pageTitleClass = "text-[28px] font-semibold tracking-[-0.5px] text-dls-text";
const sectionTitleClass = "text-[15px] font-medium tracking-[-0.2px] text-dls-text";
const panelCardClass =
  "rounded-[20px] border border-dls-border bg-dls-surface p-5 transition-all hover:border-dls-border hover:shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)]";
const pillButtonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.18)] disabled:cursor-not-allowed disabled:opacity-60";
const pillPrimaryClass = `${pillButtonClass} bg-dls-accent text-white hover:bg-[var(--dls-accent-hover)]`;
const pillSecondaryClass = `${pillButtonClass} border border-dls-border bg-dls-surface text-dls-text hover:bg-dls-hover`;
const pillGhostClass = `${pillButtonClass} border border-dls-border bg-dls-surface text-dls-secondary hover:bg-dls-hover hover:text-dls-text`;
const tagClass =
  "inline-flex items-center rounded-md border border-dls-border bg-dls-hover px-2 py-1 text-[11px] text-dls-secondary";

const OPENWORK_DEFAULT_SKILL_NAMES = new Set([
  "workspace-guide",
  "get-started",
  "skill-creator",
  "command-creator",
  "agent-creator",
  "plugin-creator",
]);

export type SkillsViewProps = {
  workspaceName: string;
  busy: boolean;
  showHeader?: boolean;
  canInstallSkillCreator: boolean;
  canUseDesktopTools: boolean;
  accessHint?: string | null;
  createSessionAndOpen: (initialPrompt?: string) => Promise<string | undefined> | string | void;
};

export default function SkillsView(props: SkillsViewProps) {
  const extensions = useExtensions();
  const platform = usePlatform();
  const statusToasts = useStatusToasts();
  // Translation helper that uses current language from i18n
  const translate = (key: string) => t(key, currentLocale());

  const skillCreatorInstalled = createMemo(() =>
    extensions.skills().some((skill) => skill.name === "skill-creator")
  );

  const [uninstallTarget, setUninstallTarget] = createSignal<SkillCard | null>(null);
  const uninstallOpen = createMemo(() => uninstallTarget() != null);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [activeFilter, setActiveFilter] = createSignal<SkillsFilter>("all");
  const [customRepoOpen, setCustomRepoOpen] = createSignal(false);
  const [customRepoOwner, setCustomRepoOwner] = createSignal("");
  const [customRepoName, setCustomRepoName] = createSignal("");
  const [customRepoRef, setCustomRepoRef] = createSignal("main");
  const [customRepoError, setCustomRepoError] = createSignal<string | null>(null);

  const [shareTarget, setShareTarget] = createSignal<SkillCard | null>(null);
  const shareOpen = createMemo(() => shareTarget() != null);
  const [shareSubView, setShareSubView] = createSignal<ShareSkillSubView>("chooser");
  const [shareBusy, setShareBusy] = createSignal(false);
  const [shareUrl, setShareUrl] = createSignal<string | null>(null);
  const [shareError, setShareError] = createSignal<string | null>(null);
  const [cloudSessionNonce, setCloudSessionNonce] = createSignal(0);
  const [shareTeamBusy, setShareTeamBusy] = createSignal(false);
  const [shareTeamError, setShareTeamError] = createSignal<string | null>(null);
  const [shareTeamSuccess, setShareTeamSuccess] = createSignal<string | null>(null);
  const [shareHubChoice, setShareHubChoice] = createSignal("");
  const [shareHubsLoading, setShareHubsLoading] = createSignal(false);
  const [shareHubsError, setShareHubsError] = createSignal<string | null>(null);
  const [shareManageableHubs, setShareManageableHubs] = createSignal<DenOrgSkillHubSummary[]>([]);

  const [selectedSkill, setSelectedSkill] = createSignal<SkillCard | null>(null);
  const [selectedContent, setSelectedContent] = createSignal("");
  const [selectedLoading, setSelectedLoading] = createSignal(false);
  const [selectedDirty, setSelectedDirty] = createSignal(false);
  const [selectedError, setSelectedError] = createSignal<string | null>(null);

  const [installingSkillCreator, setInstallingSkillCreator] = createSignal(false);
  const [installingHubSkill, setInstallingHubSkill] = createSignal<string | null>(null);
  const [installingCloudSkillId, setInstallingCloudSkillId] = createSignal<string | null>(null);
  const [denUiTick, setDenUiTick] = createSignal(0);

  onMount(() => {
    extensions.ensureHubSkillsFresh();
    extensions.ensureCloudOrgSkillsFresh();
    const onDenSession = () => {
      setDenUiTick((n) => n + 1);
      setCloudSessionNonce((n) => n + 1);
      void extensions.refreshCloudOrgSkills({ force: true });
    };
    window.addEventListener("openwork-den-session-updated", onDenSession);
    onCleanup(() => window.removeEventListener("openwork-den-session-updated", onDenSession));
  });

  const shareCloudSignedIn = createMemo(() => {
    cloudSessionNonce();
    return Boolean(readDenSettings().authToken?.trim());
  });

  const shareTeamOrgLabel = createMemo(() => {
    cloudSessionNonce();
    const name = readDenSettings().activeOrgName?.trim();
    return name || translate("skills.share_team_org_fallback");
  });

  const shareTeamDisabledReason = createMemo(() => {
    if (!shareCloudSignedIn()) return null;
    const settings = readDenSettings();
    if (!settings.activeOrgId?.trim() && !settings.activeOrgSlug?.trim()) {
      return translate("skills.share_team_choose_org");
    }
    return null;
  });

  const shareModalSubtitle = createMemo(() => {
    switch (shareSubView()) {
      case "public":
        return translate("skills.share_subtitle_public");
      case "team":
        return translate("skills.share_subtitle_team");
      default:
        return translate("skills.share_chooser_subtitle");
    }
  });

  const shareHubSelectOptions = createMemo(
    (): SelectMenuOption[] => [
      { value: "", label: translate("skills.share_team_hub_none") },
      ...shareManageableHubs().map((h) => ({ value: h.id, label: h.name })),
    ],
  );

  createEffect(() => {
    if (!shareOpen()) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (shareSubView() !== "chooser") {
        goBackShareSubView();
        return;
      }
      closeShareLink();
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  createEffect(() => {
    if (!shareOpen() || shareSubView() !== "team" || !shareCloudSignedIn()) {
      return;
    }

    let cancelled = false;
    void (async () => {
      setShareHubsLoading(true);
      setShareHubsError(null);
      try {
        const settings = readDenSettings();
        const token = settings.authToken?.trim() ?? "";
        if (!token) return;

        let orgId = settings.activeOrgId?.trim() ?? "";
        const client = createDenClient({ baseUrl: settings.baseUrl, token });
        if (!orgId) {
          const res = await client.listOrgs();
          orgId = res.orgs[0]?.id ?? "";
        }
        if (!orgId) {
          throw new Error(translate("skills.share_team_choose_org"));
        }

        const hubs = await client.listOrgSkillHubSummaries(orgId);
        if (cancelled) return;
        setShareManageableHubs(hubs.filter((h) => h.canManage));
      } catch (e) {
        if (!cancelled) {
          setShareHubsError(maskError(e));
          setShareManageableHubs([]);
        }
      } finally {
        if (!cancelled) setShareHubsLoading(false);
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  const maskError = (value: unknown) => (value instanceof Error ? value.message : "Something went wrong");
  const showToast = (title: string, tone: AppStatusToastTone = "info") => {
    statusToasts.showToast({ title, tone });
  };

  const hubRepoKey = (repo: HubSkillRepo) => `${repo.owner}/${repo.repo}@${repo.ref}`;
  const defaultHubRepoKey = "different-ai/openwork-hub@main";

  const activeHubRepoLabel = createMemo(() => (extensions.hubRepo() ? hubRepoKey(extensions.hubRepo()!) : "No hub repo selected"));

  const hasDefaultHubRepo = createMemo(() => extensions.hubRepos().some((repo) => hubRepoKey(repo) === defaultHubRepoKey));

  const selectHubRepo = (repo: HubSkillRepo) => {
    extensions.setHubRepo(repo);
    void extensions.refreshHubSkills({ force: true });
  };

  const openCustomRepoModal = () => {
    if (props.busy) return;
    setCustomRepoOpen(true);
    setCustomRepoOwner(extensions.hubRepo()?.owner ?? "");
    setCustomRepoName(extensions.hubRepo()?.repo ?? "");
    setCustomRepoRef(extensions.hubRepo()?.ref || "main");
    setCustomRepoError(null);
  };

  const closeCustomRepoModal = () => {
    setCustomRepoOpen(false);
    setCustomRepoError(null);
  };

  const saveCustomRepo = () => {
    const owner = customRepoOwner().trim();
    const repo = customRepoName().trim();
    const ref = customRepoRef().trim() || "main";
    if (!owner || !repo) {
      setCustomRepoError("Owner and repo are required.");
      return;
    }
    extensions.addHubRepo({ owner, repo, ref });
    void extensions.refreshHubSkills({ force: true });
    closeCustomRepoModal();
  };

  const filteredSkills = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    if (!query) return extensions.skills();
    return extensions.skills().filter((skill) => {
      const description = skill.description ?? "";
      return (
        skill.name.toLowerCase().includes(query) ||
        description.toLowerCase().includes(query)
      );
    });
  });

  const installedNames = createMemo(() => new Set(extensions.skills().map((skill) => skill.name)));

  const availableHubSkills = createMemo(() =>
    extensions.hubSkills().filter((skill) => !installedNames().has(skill.name))
  );

  const filteredHubSkills = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    const items = availableHubSkills();
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
  });

  const filteredCloudOrgSkills = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    const items = extensions.cloudOrgSkills();
    if (!query) return items;
    return items.filter((skill) => {
      const description = skill.description ?? "";
      const hub = skill.hubName ?? "";
      return (
        skill.title.toLowerCase().includes(query) ||
        description.toLowerCase().includes(query) ||
        hub.toLowerCase().includes(query)
      );
    });
  });

  const cloudOrgLabel = createMemo(() => {
    denUiTick();
    const name = readDenSettings().activeOrgName?.trim();
    if (name) return name;
    return translate("skills.cloud_org_fallback");
  });

  const cloudSessionReady = createMemo(() => {
    denUiTick();
    const s = readDenSettings();
    return Boolean(s.authToken?.trim() && s.activeOrgId?.trim());
  });

  const cloudNeedsSignIn = createMemo(() => {
    denUiTick();
    return !readDenSettings().authToken?.trim();
  });

  const installSkillCreator = async () => {
    if (props.busy || installingSkillCreator()) return;
    if (!props.canInstallSkillCreator) {
      showToast(props.accessHint ?? translate("skills.host_only_error"), "warning");
      return;
    }
    setInstallingSkillCreator(true);
    showToast(translate("skills.installing_skill_creator"));
    try {
      const result = await extensions.installSkillCreator();
      showToast(result.message, "success");
    } catch (e) {
      showToast(e instanceof Error ? e.message : translate("skills.install_failed"), "error");
    } finally {
      setInstallingSkillCreator(false);
    }
  };

  const installFromCloud = async (skill: DenOrgSkillCard) => {
    if (props.busy || installingCloudSkillId()) return;
    setInstallingCloudSkillId(skill.id);
    showToast(t("skills.cloud_installing", currentLocale(), { title: skill.title }));
    try {
      const result = await extensions.installCloudOrgSkill(skill);
      showToast(result.message, result.ok ? "success" : "error");
    } catch (e) {
      showToast(e instanceof Error ? e.message : translate("skills.install_failed"), "error");
    } finally {
      setInstallingCloudSkillId(null);
    }
  };

  const openCloudSignIn = () => {
    const base = readDenSettings().baseUrl?.trim() || DEFAULT_DEN_BASE_URL;
    platform.openLink(buildDenAuthUrl(base, "sign-in"));
  };

  const installFromHub = async (skill: HubSkillCard) => {
    if (props.busy || installingHubSkill()) return;
    setInstallingHubSkill(skill.name);
    showToast(`Installing ${skill.name}…`);
    try {
      const result = await extensions.installHubSkill(skill.name);
      showToast(result.message, "success");
    } catch (e) {
      showToast(e instanceof Error ? e.message : translate("skills.install_failed"), "error");
    } finally {
      setInstallingHubSkill(null);
    }
  };

  const handleNewSkill = async () => {
    if (props.busy) return;
    // Ensure skill-creator exists when we can.
    if (props.canInstallSkillCreator && !skillCreatorInstalled()) {
      await installSkillCreator();
    }
    await Promise.resolve(props.createSessionAndOpen("/skill-creator"));
  };

  const openShareLink = (skill: SkillCard) => {
    if (props.busy) return;
    setShareTarget(skill);
    setShareSubView("chooser");
    setShareBusy(false);
    setShareUrl(null);
    setShareError(null);
    setShareTeamBusy(false);
    setShareTeamError(null);
    setShareTeamSuccess(null);
    setShareHubChoice("");
    setShareHubsError(null);
    setShareManageableHubs([]);
    setCloudSessionNonce((n) => n + 1);
  };

  const closeShareLink = () => {
    setShareTarget(null);
    setShareSubView("chooser");
    setShareBusy(false);
    setShareUrl(null);
    setShareError(null);
    setShareTeamBusy(false);
    setShareTeamError(null);
    setShareTeamSuccess(null);
    setShareHubChoice("");
    setShareHubsError(null);
    setShareManageableHubs([]);
  };

  const goBackShareSubView = () => {
    setShareSubView("chooser");
    setShareError(null);
    setShareTeamError(null);
    setShareTeamSuccess(null);
    setShareHubChoice("");
    setShareHubsError(null);
  };

  const startShareSkillSignIn = () => {
    const settings = readDenSettings();
    platform.openLink(buildDenAuthUrl(settings.baseUrl, "sign-in"));
  };

  const publishSkillToTeam = async () => {
    const target = shareTarget();
    if (!target) return;
    if (props.busy || shareTeamBusy() || shareTeamDisabledReason()) return;
    setShareTeamBusy(true);
    setShareTeamError(null);
    setShareTeamSuccess(null);
    try {
      const skill = await extensions.readSkill(target.name);
      if (!skill) throw new Error("Failed to load skill");
      const hubId = shareHubChoice().trim();
      const { orgName, orgId } = await saveInstalledSkillToOpenWorkOrg({
        skillText: skill.content,
        skillHubId: hubId || null,
      });
      setShareTeamSuccess(t("skills.share_team_success", currentLocale(), { org: orgName }));
      window.dispatchEvent(
        new CustomEvent<{ orgId: string }>("openwork-den-org-skills-changed", { detail: { orgId } }),
      );
      void extensions.refreshCloudOrgSkills({ force: true });
    } catch (e) {
      setShareTeamError(maskError(e));
    } finally {
      setShareTeamBusy(false);
    }
  };

  const publishShareLink = async () => {
    const target = shareTarget();
    if (!target) return;
    if (props.busy || shareBusy()) return;
    setShareBusy(true);
    setShareUrl(null);
    setShareError(null);

    try {
      const skill = await extensions.readSkill(target.name);
      if (!skill) throw new Error("Failed to load skill");

      const payload: SkillBundleV1 = {
        schemaVersion: 1,
        type: "skill",
        name: target.name,
        content: skill.content,
        description: target.description ?? undefined,
        trigger: target.trigger ?? undefined,
      };

      const result = await publishOpenworkBundleJson({
        payload,
        bundleType: "skill",
        name: target.name,
      });

      setShareUrl(result.url);
      try {
        await navigator.clipboard.writeText(result.url);
        showToast("Link copied", "success");
      } catch {
        // ignore
      }
    } catch (e) {
      setShareError(maskError(e));
    } finally {
      setShareBusy(false);
    }
  };

  const copyShareLink = async () => {
    const url = shareUrl()?.trim();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      showToast("Link copied", "success");
    } catch {
      setShareError("Failed to copy link");
    }
  };

  const openSkill = async (skill: SkillCard) => {
    if (props.busy) return;
    setSelectedSkill(skill);
    setSelectedContent("");
    setSelectedDirty(false);
    setSelectedError(null);
    setSelectedLoading(true);
    try {
      const result = await extensions.readSkill(skill.name);
      if (!result) {
        setSelectedError("Failed to load skill.");
        return;
      }
      setSelectedContent(result.content);
    } catch (e) {
      setSelectedError(e instanceof Error ? e.message : "Failed to load skill.");
    } finally {
      setSelectedLoading(false);
    }
  };

  const closeSkill = () => {
    setSelectedSkill(null);
    setSelectedContent("");
    setSelectedDirty(false);
    setSelectedError(null);
    setSelectedLoading(false);
  };

  const saveSelectedSkill = async () => {
    const skill = selectedSkill();
    if (!skill) return;
    if (!selectedDirty()) return;
    setSelectedError(null);
    try {
      await Promise.resolve(
        extensions.saveSkill({
          name: skill.name,
          content: selectedContent(),
          description: skill.description,
        }),
      );
      setSelectedDirty(false);
    } catch (e) {
      setSelectedError(e instanceof Error ? e.message : "Failed to save skill.");
    }
  };

  const canCreateInChat = createMemo(
    () => !props.busy && (props.canInstallSkillCreator || props.canUseDesktopTools)
  );

  const showInstalledSection = createMemo(() => activeFilter() === "all" || activeFilter() === "installed");
  const showCloudSection = createMemo(() => activeFilter() === "all" || activeFilter() === "cloud");
  const showHubSection = createMemo(() => activeFilter() === "all" || activeFilter() === "hub");

  const isOpenworkInjectedSkill = (skill: SkillCard) => {
    const normalizedName = skill.name.trim().toLowerCase();
    const normalizedPath = skill.path.replace(/\\/g, "/").toLowerCase();
    const inProjectSkillPath = normalizedPath.includes("/.opencode/skills/");
    if (!inProjectSkillPath) return false;
    return OPENWORK_DEFAULT_SKILL_NAMES.has(normalizedName) || normalizedName.endsWith("-creator");
  };

  const runDesktopAction = (action: () => void | Promise<void>) => {
    if (props.busy) return;
    if (!props.canUseDesktopTools) {
      showToast(translate("skills.desktop_required"), "warning");
      return;
    }
    void Promise.resolve(action());
  };

  const refreshCatalogs = () => {
    if (props.busy) return;
    void extensions.refreshSkills({ force: true });
    void extensions.refreshHubSkills({ force: true });
    void extensions.refreshCloudOrgSkills({ force: true });
  };

  return (
    <section class="space-y-8">
      <div class="space-y-6">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div class="min-w-0">
            <Show when={props.showHeader !== false}>
              <h2 class={pageTitleClass}>{translate("skills.title")}</h2>
            </Show>
            <p class="mt-2 max-w-2xl text-[14px] leading-relaxed text-dls-secondary">
              Skills are the core abilities of this worker. Discover them from Hub, manage what is installed, and create new ones directly in chat.
            </p>
          </div>

          <div class="flex flex-wrap gap-3 lg:justify-end">
            <button
              type="button"
              onClick={() => runDesktopAction(extensions.importLocalSkill)}
              disabled={props.busy || !props.canUseDesktopTools}
              class={pillSecondaryClass}
            >
              <Upload size={14} />
              Import local skill
            </button>
            <button
              type="button"
              onClick={() => runDesktopAction(extensions.revealSkillsFolder)}
              disabled={props.busy || !props.canUseDesktopTools}
              class={pillSecondaryClass}
            >
              <FolderOpen size={14} />
              Reveal folder
            </button>
            <button
              type="button"
              onClick={handleNewSkill}
              disabled={!canCreateInChat()}
              class={pillPrimaryClass}
            >
              <Sparkles size={14} />
              Create skill in chat
            </button>
          </div>
        </div>

        <div class="flex flex-col gap-3 rounded-[20px] border border-dls-border bg-dls-surface p-4 md:flex-row md:items-center md:justify-between">
          <div class="relative min-w-0 flex-1">
            <Search size={16} class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-dls-secondary" />
            <input
              type="text"
              value={searchQuery()}
              onInput={(event) => setSearchQuery(event.currentTarget.value)}
              placeholder={translate("skills.catalog_search_placeholder")}
              class="w-full rounded-xl border border-dls-border bg-dls-surface py-3 pl-11 pr-4 text-[14px] text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.12)]"
            />
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <For each={["all", "installed", "cloud", "hub"] as SkillsFilter[]}>
              {(filter) => (
                <button
                  type="button"
                  onClick={() => setActiveFilter(filter)}
                  class={activeFilter() === filter ? pillPrimaryClass : pillGhostClass}
                >
                  {filter === "all"
                    ? translate("skills.filter_all")
                    : filter === "installed"
                      ? translate("skills.filter_installed")
                      : filter === "cloud"
                        ? translate("skills.filter_cloud")
                        : translate("skills.filter_hub")}
                </button>
              )}
            </For>
            <button
              type="button"
              onClick={refreshCatalogs}
              disabled={props.busy}
              class={pillSecondaryClass}
            >
              <RefreshCw size={14} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      <Show when={props.accessHint}>
        <div class="rounded-[20px] border border-dls-border bg-dls-hover px-5 py-4 text-[13px] text-dls-secondary">
          {props.accessHint}
        </div>
      </Show>
      <Show
        when={!props.accessHint && !props.canInstallSkillCreator && !props.canUseDesktopTools}
      >
        <div class="rounded-[20px] border border-dls-border bg-dls-hover px-5 py-4 text-[13px] text-dls-secondary">
          {translate("skills.host_mode_only")}
        </div>
      </Show>

      <Show when={extensions.skillsStatus()}>
        <div class="rounded-[20px] border border-dls-border bg-dls-hover px-5 py-4 text-[13px] text-dls-secondary whitespace-pre-wrap break-words">
          {extensions.skillsStatus()}
        </div>
      </Show>

      <Show when={showInstalledSection()}>
        <div class="space-y-4">
          <div class="flex items-end justify-between gap-3">
            <div>
              <h3 class={sectionTitleClass}>{translate("skills.installed")}</h3>
              <p class="mt-1 text-[13px] text-dls-secondary">
                Installed skills live on this worker and can be edited or shared.
              </p>
            </div>
            <div class="text-[12px] text-dls-secondary">{filteredSkills().length} shown</div>
          </div>

          <Show
            when={filteredSkills().length}
            fallback={
              <div class="rounded-[20px] border border-dashed border-dls-border bg-dls-surface px-5 py-8 text-[14px] text-dls-secondary">
                {translate("skills.no_skills")}
              </div>
            }
          >
            <div class="rounded-[24px] bg-dls-hover p-4">
              <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
                <For each={filteredSkills()}>
                  {(skill) => (
                    <div
                      role="button"
                      tabindex="0"
                      class={`${panelCardClass} flex cursor-pointer flex-col gap-4 text-left`}
                      onClick={() => void openSkill(skill)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          if (e.isComposing || e.keyCode === 229) return;
                          e.preventDefault();
                          void openSkill(skill);
                        }
                      }}
                    >
                      <div class="flex gap-4 min-w-0">
                        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
                          <Package size={20} class="text-dls-secondary" />
                        </div>
                        <div class="min-w-0 flex-1">
                          <div class="flex flex-wrap items-center gap-2">
                            <h4 class="text-[14px] font-semibold text-dls-text truncate">{skill.name}</h4>
                            <Show when={isOpenworkInjectedSkill(skill)}>
                              <span class={tagClass}>OpenWork</span>
                            </Show>
                          </div>
                          <Show when={skill.description} fallback={<p class="mt-2 text-[13px] text-dls-secondary">No description yet.</p>}>
                            <p class="mt-2 line-clamp-2 text-[13px] leading-relaxed text-dls-secondary">
                              {skill.description}
                            </p>
                          </Show>
                        </div>
                      </div>

                      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-dls-border pt-4">
                        <span class={tagClass}>Installed</span>
                        <div class="flex flex-wrap gap-2">
                          <button
                            type="button"
                            class={pillGhostClass}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              openShareLink(skill);
                            }}
                            disabled={props.busy}
                            title="Share"
                          >
                            <Share2 size={14} />
                            Share
                          </button>
                          <button
                            type="button"
                            class={pillSecondaryClass}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              void openSkill(skill);
                            }}
                            disabled={props.busy}
                            title="Edit"
                          >
                            <Edit2 size={14} />
                            Edit
                          </button>
                          <button
                            type="button"
                            class={pillGhostClass}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              if (props.busy || !props.canUseDesktopTools) {
                                if (!props.canUseDesktopTools) showToast(translate("skills.desktop_required"), "warning");
                                return;
                              }
                              setUninstallTarget(skill);
                            }}
                            disabled={props.busy || !props.canUseDesktopTools}
                            title={translate("skills.uninstall")}
                          >
                            <Trash2 size={14} />
                            Remove
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={showCloudSection()}>
        <div class="space-y-4">
          <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p class="mb-0.5 text-[12px] text-dls-secondary">{cloudOrgLabel()}</p>
              <h3 class={sectionTitleClass}>{translate("skills.cloud_section_title")}</h3>
              <p class="mt-1 max-w-2xl text-[13px] leading-relaxed text-dls-secondary">
                {translate("skills.cloud_section_subtitle")}
              </p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void extensions.refreshCloudOrgSkills({ force: true })}
                disabled={props.busy}
                class={pillSecondaryClass}
              >
                <RefreshCw size={14} />
                {translate("skills.cloud_refresh")}
              </button>
            </div>
          </div>

          <Show when={!cloudSessionReady()}>
            <div class="rounded-[20px] border border-dashed border-dls-border bg-dls-surface px-5 py-6 text-[14px] text-dls-secondary">
              <Show
                when={cloudNeedsSignIn()}
                fallback={
                  <div class="space-y-3">
                    <p>{translate("skills.cloud_choose_org_hint")}</p>
                    <p class="text-[13px]">{translate("skills.cloud_choose_org_detail")}</p>
                  </div>
                }
              >
                <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p>{translate("skills.cloud_sign_in_hint")}</p>
                  <button type="button" class={pillPrimaryClass} onClick={() => openCloudSignIn()}>
                    {translate("skills.cloud_sign_in")}
                  </button>
                </div>
              </Show>
            </div>
          </Show>

          <Show when={cloudSessionReady()}>
            <Show when={extensions.cloudOrgSkillsStatus()}>
              <div class="rounded-[20px] border border-dls-border bg-dls-hover px-5 py-4 text-[13px] text-dls-secondary whitespace-pre-wrap break-words">
                {extensions.cloudOrgSkillsStatus()}
              </div>
            </Show>

            <Show
              when={filteredCloudOrgSkills().length}
              fallback={
                <div class="rounded-[20px] border border-dashed border-dls-border bg-dls-surface px-5 py-8 text-[14px] text-dls-secondary">
                  {extensions.cloudOrgSkills().length === 0
                    ? translate("skills.cloud_org_empty")
                    : translate("skills.cloud_no_search_matches")}
                </div>
              }
            >
              <div class="rounded-[24px] bg-dls-hover p-4">
                <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <For each={filteredCloudOrgSkills()}>
                    {(skill) => (
                      <div class={`${panelCardClass} flex flex-col gap-4 text-left`}>
                        <div class="flex gap-4 min-w-0">
                          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
                            <Cloud size={20} class="text-dls-secondary" />
                          </div>
                          <div class="min-w-0 flex-1">
                            <h4 class="text-[14px] font-semibold text-dls-text truncate">{skill.title}</h4>
                            <Show when={skill.description}>
                              <p class="mt-2 line-clamp-2 text-[13px] leading-relaxed text-dls-secondary">
                                {skill.description}
                              </p>
                            </Show>
                            <div class="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-dls-secondary">
                              <Show when={skill.hubName}>
                                <span class={tagClass}>
                                  {t("skills.cloud_hub_label", currentLocale(), { name: skill.hubName ?? "" })}
                                </span>
                              </Show>
                              <Show when={skill.shared === "org"}>
                                <span class={tagClass}>{translate("skills.cloud_shared_org")}</span>
                              </Show>
                              <Show when={skill.shared === "public"}>
                                <span class={tagClass}>{translate("skills.cloud_shared_public")}</span>
                              </Show>
                            </div>
                          </div>
                        </div>

                        <div class="flex items-center justify-between gap-3 border-t border-dls-border pt-4">
                          <span class={tagClass}>{translate("skills.cloud_footer_label")}</span>
                          <button
                            type="button"
                            class={
                              installingCloudSkillId() === skill.id ? pillSecondaryClass : pillPrimaryClass
                            }
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              void installFromCloud(skill);
                            }}
                            disabled={props.busy || installingCloudSkillId() === skill.id}
                          >
                            <Show when={installingCloudSkillId() === skill.id} fallback={<Plus size={14} />}>
                              <Loader2 size={14} class="animate-spin" />
                            </Show>
                            {installingCloudSkillId() === skill.id
                              ? translate("skills.cloud_installing_short")
                              : translate("skills.cloud_add_skill")}
                          </button>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </Show>
        </div>
      </Show>

      <Show when={showHubSection()}>
        <div class="space-y-4">
          <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h3 class={sectionTitleClass}>Available from Hub</h3>
              <p class="mt-1 text-[13px] text-dls-secondary">
                Browse shared skills from GitHub-backed hubs and add them to this worker.
              </p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  extensions.addHubRepo({ owner: "different-ai", repo: "openwork-hub", ref: "main" });
                  void extensions.refreshHubSkills({ force: true });
                }}
                class={pillGhostClass}
                disabled={props.busy || hasDefaultHubRepo()}
              >
                <Plus size={14} />
                Add OpenWork Hub
              </button>
            <button
              type="button"
              onClick={openCustomRepoModal}
              disabled={props.busy}
              class={pillSecondaryClass}
              title="Add custom GitHub repo"
            >
              <Plus size={14} />
              Add git repo
            </button>
            <button
              type="button"
              onClick={() => void extensions.refreshHubSkills({ force: true })}
              disabled={props.busy}
              class={pillSecondaryClass}
              title="Refresh hub catalog"
            >
              <RefreshCw size={14} />
              Refresh hub
            </button>
            </div>
          </div>

          <div class="space-y-3 rounded-[20px] border border-dls-border bg-dls-surface p-4">
            <div class="text-[12px] text-dls-secondary">
              Source: <span class="font-mono text-dls-text">{activeHubRepoLabel()}</span>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <For each={extensions.hubRepos()}>
                {(repo) => {
                  const key = hubRepoKey(repo);
                  const active = extensions.hubRepo() ? key === hubRepoKey(extensions.hubRepo()!) : false;
                  return (
                    <div class="inline-flex items-center overflow-hidden rounded-full border border-dls-border bg-dls-surface">
                      <button
                        type="button"
                        onClick={() => selectHubRepo(repo)}
                        class={`px-3 py-1.5 text-[12px] font-medium transition-colors ${
                          active ? "bg-dls-accent text-white" : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
                        }`}
                        disabled={props.busy}
                      >
                        {key}
                      </button>
                      <button
                        type="button"
                        class="px-2 py-1.5 text-[12px] text-dls-secondary transition-colors hover:bg-dls-hover hover:text-red-11"
                        onClick={() => {
                          extensions.removeHubRepo(repo);
                          void extensions.refreshHubSkills({ force: true });
                        }}
                        disabled={props.busy}
                        title="Remove saved repo"
                      >
                        ×
                      </button>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>

        <Show when={extensions.hubSkillsStatus()}>
          <div class="rounded-[20px] border border-dls-border bg-dls-hover px-5 py-4 text-[13px] text-dls-secondary whitespace-pre-wrap break-words">
            {extensions.hubSkillsStatus()}
          </div>
        </Show>

        <Show
          when={filteredHubSkills().length}
          fallback={
            <div class="rounded-[20px] border border-dashed border-dls-border bg-dls-surface px-5 py-8 text-[14px] text-dls-secondary">
              {extensions.hubRepo() ? "No hub skills available." : "No hub repo selected. Add a GitHub repo to browse skills."}
            </div>
          }
        >
          <div class="rounded-[24px] bg-dls-hover p-4">
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
              <For each={filteredHubSkills()}>
                {(skill) => (
                  <div class={`${panelCardClass} flex flex-col gap-4 text-left`}>
                    <div class="flex gap-4 min-w-0">
                      <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
                        <Package size={20} class="text-dls-secondary" />
                      </div>
                      <div class="min-w-0 flex-1">
                        <h4 class="text-[14px] font-semibold text-dls-text truncate">{skill.name}</h4>
                        <Show
                          when={skill.description}
                          fallback={<p class="mt-2 text-[13px] text-dls-secondary">From {skill.source.owner}/{skill.source.repo}</p>}
                        >
                          <p class="mt-2 line-clamp-2 text-[13px] leading-relaxed text-dls-secondary">{skill.description}</p>
                        </Show>
                        <div class="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-dls-secondary">
                          <span class={`${tagClass} font-mono`}>
                            {skill.source.owner}/{skill.source.repo}
                          </span>
                          <Show when={skill.trigger}>
                            <span class={tagClass} title={`Trigger: ${skill.trigger}`}>
                              Trigger: {skill.trigger}
                            </span>
                          </Show>
                        </div>
                      </div>
                    </div>

                    <div class="flex items-center justify-between gap-3 border-t border-dls-border pt-4">
                      <span class={tagClass}>Hub</span>
                      <button
                        type="button"
                        class={installingHubSkill() === skill.name ? pillSecondaryClass : pillPrimaryClass}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void installFromHub(skill);
                        }}
                        disabled={props.busy || installingHubSkill() === skill.name}
                        title={`Install ${skill.name}`}
                      >
                        <Show
                          when={installingHubSkill() === skill.name}
                          fallback={<Plus size={14} />}
                        >
                          <Loader2 size={14} class="animate-spin" />
                        </Show>
                        {installingHubSkill() === skill.name ? "Installing" : "Add skill"}
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
        </div>
      </Show>

      <Show when={selectedSkill()}>
        <div class="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="w-full max-w-4xl rounded-2xl border border-dls-border bg-dls-surface shadow-2xl overflow-hidden">
            <div class="px-5 py-4 border-b border-dls-border flex items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="text-sm font-semibold text-dls-text truncate">{selectedSkill()!.name}</div>
              </div>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                    selectedDirty() && !props.busy
                      ? "bg-dls-text text-dls-surface hover:opacity-90"
                      : "bg-dls-active text-dls-secondary"
                  }`}
                  disabled={!selectedDirty() || props.busy}
                  onClick={() => void saveSelectedSkill()}
                >
                  Save
                </button>
                <button
                  type="button"
                  class="px-3 py-1.5 text-xs font-medium rounded-lg bg-dls-hover text-dls-text hover:bg-dls-active transition-colors"
                  onClick={closeSkill}
                >
                  Close
                </button>
              </div>
            </div>

            <div class="p-5">
              <Show when={selectedError()}>
                <div class="mb-3 rounded-xl border border-red-7/20 bg-red-1/40 px-4 py-3 text-xs text-red-12">
                  {selectedError()}
                </div>
              </Show>
              <Show
                when={!selectedLoading()}
                fallback={<div class="text-xs text-dls-secondary">Loading…</div>}
              >
                <textarea
                  value={selectedContent()}
                  onInput={(e) => {
                    setSelectedContent(e.currentTarget.value);
                    setSelectedDirty(true);
                  }}
                  class="w-full min-h-[420px] rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-xs font-mono text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb)/0.25)]"
                  spellcheck={false}
                />
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <Show when={uninstallOpen()}>
        <div class="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="bg-dls-surface border border-dls-border w-full max-w-md rounded-2xl shadow-2xl overflow-hidden">
            <div class="p-6">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h3 class="text-lg font-semibold text-dls-text">{translate("skills.uninstall_title")}</h3>
                  <p class="text-sm text-dls-secondary mt-1">
                    {translate("skills.uninstall_warning").replace("{name}", uninstallTarget()?.name ?? "")}
                  </p>
                </div>
              </div>

              <div class="mt-6 flex justify-end gap-2">
                <Button variant="outline" onClick={() => setUninstallTarget(null)} disabled={props.busy}>
                  {translate("common.cancel")}
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    const target = uninstallTarget();
                    setUninstallTarget(null);
                    if (!target) return;
                    extensions.uninstallSkill(target.name);
                  }}
                  disabled={props.busy}
                >
                  {translate("skills.uninstall")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <Show when={shareOpen()}>
        <div class={`${modalOverlayClass} items-start pt-[10vh]`}>
          <div class={`${modalShellClass} max-h-[78vh] max-w-md`} role="dialog" aria-modal="true">
            <div class={modalHeaderClass}>
              <div class="flex min-w-0 items-start gap-3">
                <Show when={shareSubView() !== "chooser"}>
                  <button
                    type="button"
                    onClick={goBackShareSubView}
                    class={modalHeaderButtonClass}
                    aria-label={translate("skills.share_back")}
                  >
                    <ArrowLeft size={16} />
                  </button>
                </Show>
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <h2 class={modalTitleClass}>{translate("skills.share_title")}</h2>
                    <Show when={shareSubView() === "chooser"}>
                      <span class={shareTagClass}>{shareTarget()?.name}</span>
                    </Show>
                  </div>
                  <p class={modalSubtitleClass}>{shareModalSubtitle()}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={closeShareLink}
                class={modalHeaderButtonClass}
                aria-label={translate("skills.share_close")}
                title={translate("skills.share_close")}
              >
                <X size={16} />
              </button>
            </div>

            <div class="flex-1 overflow-y-auto px-6 pb-7 pt-2">
              <Show when={shareSubView() === "chooser"}>
                <div class="space-y-4 animate-in fade-in slide-in-from-bottom-3 duration-300">
                  <WorkspaceOptionCard
                    title={translate("skills.share_option_team_title")}
                    description={translate("skills.share_option_team_desc")}
                    icon={Users}
                    onClick={() => setShareSubView("team")}
                  />
                  <WorkspaceOptionCard
                    title={translate("skills.share_option_public_title")}
                    description={translate("skills.share_option_public_desc")}
                    icon={Rocket}
                    onClick={() => setShareSubView("public")}
                  />
                </div>
              </Show>

              <Show when={shareSubView() === "public"}>
                <div class="space-y-5 pt-2 animate-in fade-in slide-in-from-right-4 duration-300">
                  <p class="text-[14px] leading-relaxed text-dls-secondary">{translate("skills.share_public_intro")}</p>

                  <div class={surfaceCardClass}>
                    <div class="mb-3 text-[12px] text-dls-secondary font-mono break-all">
                      {translate("skills.share_publisher_label")}: {DEFAULT_OPENWORK_PUBLISHER_BASE_URL}
                    </div>

                    <Show when={shareError()}>
                      <div class={`mb-3 ${modalNoticeErrorClass}`}>{shareError()}</div>
                    </Show>

                    <Show
                      when={shareUrl()}
                      fallback={
                        <button
                          type="button"
                          onClick={() => void publishShareLink()}
                          disabled={shareBusy() || props.busy}
                          class={`${sharePillPrimaryClass} w-full`}
                        >
                          {shareBusy() ? translate("skills.share_public_creating") : translate("skills.share_public_create")}
                        </button>
                      }
                    >
                      <div class="flex items-center gap-2">
                        <input type="text" readonly value={shareUrl()!} class={`${inputClass} flex-1 font-mono text-[12px]`} />
                        <button type="button" onClick={() => void copyShareLink()} class={sharePillSecondaryClass}>
                          <Copy size={14} class="mr-1 inline" />
                          {translate("skills.share_copy_link")}
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => void publishShareLink()}
                        disabled={shareBusy()}
                        class={`${sharePillSecondaryClass} mt-3 w-full`}
                      >
                        {shareBusy() ? translate("skills.share_public_creating") : translate("skills.share_public_regenerate")}
                      </button>
                    </Show>
                  </div>

                  <div class="flex justify-end">
                    <button type="button" onClick={closeShareLink} class={sharePillSecondaryClass}>
                      {translate("skills.share_done")}
                    </button>
                  </div>
                </div>
              </Show>

              <Show when={shareSubView() === "team"}>
                <div class="space-y-5 pt-2 animate-in fade-in slide-in-from-right-4 duration-300">
                  <p class="text-[14px] leading-relaxed text-dls-secondary">{translate("skills.share_team_intro")}</p>

                  <div class={surfaceCardClass}>
                    <div class="flex flex-wrap items-center gap-2">
                      <span class={shareTagClass}>{shareTeamOrgLabel()}</span>
                    </div>

                    <Show when={shareTeamError()?.trim()}>
                      <div class={`mt-4 ${modalNoticeErrorClass}`}>{shareTeamError()}</div>
                    </Show>

                    <Show when={shareTeamSuccess()?.trim()}>
                      <div class={`mt-4 ${modalNoticeSuccessClass}`}>{shareTeamSuccess()}</div>
                    </Show>

                    <Show when={shareHubsError()?.trim()}>
                      <div class={`mt-4 ${modalNoticeErrorClass}`}>{shareHubsError()}</div>
                    </Show>

                    <Show when={shareCloudSignedIn() && shareTeamDisabledReason()?.trim()}>
                      <div class="mt-4 text-[12px] text-dls-secondary">{shareTeamDisabledReason()}</div>
                    </Show>

                    <Show when={shareCloudSignedIn() && shareManageableHubs().length > 0}>
                      <div class="mt-4">
                        <span
                          id="skills-share-hub-label"
                          class="mb-1.5 block text-[13px] font-medium text-dls-text"
                        >
                          {translate("skills.share_team_hub_label")}
                        </span>
                        <SelectMenu
                          aria-labelledby="skills-share-hub-label"
                          options={shareHubSelectOptions()}
                          value={shareHubChoice()}
                          onChange={setShareHubChoice}
                          disabled={shareTeamBusy() || Boolean(shareTeamSuccess()?.trim())}
                        />
                      </div>
                    </Show>

                    <Show when={shareCloudSignedIn() && shareHubsLoading()}>
                      <div class="mt-3 flex items-center gap-2 text-[12px] text-dls-secondary">
                        <Loader2 size={14} class="animate-spin" />
                        {translate("skills.share_team_hubs_loading")}
                      </div>
                    </Show>

                    <button
                      type="button"
                      onClick={() => {
                        if (!shareCloudSignedIn()) {
                          startShareSkillSignIn();
                          return;
                        }
                        void publishSkillToTeam();
                      }}
                      disabled={
                        shareCloudSignedIn()
                          ? Boolean(shareTeamDisabledReason()) || shareTeamBusy() || Boolean(shareTeamSuccess()?.trim())
                          : false
                      }
                      class={`${sharePillPrimaryClass} mt-4 w-full`}
                    >
                      {!shareCloudSignedIn()
                        ? translate("skills.share_team_sign_in")
                        : shareTeamBusy()
                          ? translate("skills.share_team_saving")
                          : translate("skills.share_team_save")}
                    </button>

                    <Show when={!shareCloudSignedIn()}>
                      <p class="mt-3 text-[12px] text-dls-secondary">{translate("skills.share_team_sign_in_hint")}</p>
                    </Show>
                  </div>

                  <div class="flex justify-end">
                    <button type="button" onClick={closeShareLink} class={sharePillSecondaryClass}>
                      {translate("skills.share_done")}
                    </button>
                  </div>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <Show when={customRepoOpen()}>
        <div class="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="bg-dls-surface border border-dls-border w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden">
            <div class="p-6 space-y-4">
              <div>
                <h3 class="text-lg font-semibold text-dls-text">Add custom GitHub repo</h3>
                <p class="text-sm text-dls-secondary mt-1">
                  Skills are loaded from <span class="font-mono">skills/&lt;name&gt;/SKILL.md</span>.
                </p>
              </div>

              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label class="space-y-1">
                  <div class="text-xs font-semibold uppercase tracking-widest text-dls-secondary">Owner</div>
                  <input
                    type="text"
                    value={customRepoOwner()}
                    onInput={(e) => setCustomRepoOwner(e.currentTarget.value)}
                    placeholder="different-ai"
                    class="w-full bg-dls-hover border border-dls-border rounded-lg px-3 py-2 text-xs font-mono text-dls-text focus:outline-none"
                    spellcheck={false}
                  />
                </label>
                <label class="space-y-1">
                  <div class="text-xs font-semibold uppercase tracking-widest text-dls-secondary">Repo</div>
                  <input
                    type="text"
                    value={customRepoName()}
                    onInput={(e) => setCustomRepoName(e.currentTarget.value)}
                    placeholder="openwork-hub"
                    class="w-full bg-dls-hover border border-dls-border rounded-lg px-3 py-2 text-xs font-mono text-dls-text focus:outline-none"
                    spellcheck={false}
                  />
                </label>
              </div>

              <label class="space-y-1">
                <div class="text-xs font-semibold uppercase tracking-widest text-dls-secondary">Ref (branch/tag/commit)</div>
                <input
                  type="text"
                  value={customRepoRef()}
                  onInput={(e) => setCustomRepoRef(e.currentTarget.value)}
                  placeholder="main"
                  class="w-full bg-dls-hover border border-dls-border rounded-lg px-3 py-2 text-xs font-mono text-dls-text focus:outline-none"
                  spellcheck={false}
                />
              </label>

              <Show when={customRepoError()}>
                <div class="rounded-xl border border-red-7/20 bg-red-1/40 px-4 py-3 text-xs text-red-12">
                  {customRepoError()}
                </div>
              </Show>

              <div class="flex justify-end gap-2">
                <Button variant="outline" onClick={closeCustomRepoModal} disabled={props.busy}>
                  {translate("common.cancel")}
                </Button>
                <Button variant="secondary" onClick={saveCustomRepo} disabled={props.busy}>
                  Save and load
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </section>
  );
}
