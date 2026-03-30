import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import type { HubSkillCard, HubSkillRepo, SkillCard } from "../types";
import { useExtensions } from "../extensions/provider";
import type { SkillBundleV1 } from "../bundles/types";

import Button from "../components/button";
import { Copy, Edit2, FolderOpen, Loader2, Package, Plus, RefreshCw, Search, Share2, Sparkles, Trash2, Upload } from "lucide-solid";
import { currentLocale, t } from "../../i18n";
import { DEFAULT_OPENWORK_PUBLISHER_BASE_URL, publishOpenworkBundleJson } from "../lib/publisher";

type InstallResult = { ok: boolean; message: string };
type SkillsFilter = "all" | "installed" | "hub";

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
  createSessionAndOpen: () => void;
  setPrompt: (value: string) => void;
};

export default function SkillsView(props: SkillsViewProps) {
  const extensions = useExtensions();
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
  const [shareBusy, setShareBusy] = createSignal(false);
  const [shareUrl, setShareUrl] = createSignal<string | null>(null);
  const [shareError, setShareError] = createSignal<string | null>(null);

  const [selectedSkill, setSelectedSkill] = createSignal<SkillCard | null>(null);
  const [selectedContent, setSelectedContent] = createSignal("");
  const [selectedLoading, setSelectedLoading] = createSignal(false);
  const [selectedDirty, setSelectedDirty] = createSignal(false);
  const [selectedError, setSelectedError] = createSignal<string | null>(null);

  const [toast, setToast] = createSignal<string | null>(null);
  const [installingSkillCreator, setInstallingSkillCreator] = createSignal(false);
  const [installingHubSkill, setInstallingHubSkill] = createSignal<string | null>(null);

  onMount(() => {
    extensions.ensureHubSkillsFresh();
  });

  createEffect(() => {
    const message = toast();
    if (!message) return;
    const id = window.setTimeout(() => setToast(null), 2400);
    onCleanup(() => window.clearTimeout(id));
  });

  const maskError = (value: unknown) => (value instanceof Error ? value.message : "Something went wrong");

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

  const installSkillCreator = async () => {
    if (props.busy || installingSkillCreator()) return;
    if (!props.canInstallSkillCreator) {
      setToast(props.accessHint ?? translate("skills.host_only_error"));
      return;
    }
    setInstallingSkillCreator(true);
    setToast(translate("skills.installing_skill_creator"));
    try {
      const result = await extensions.installSkillCreator();
      setToast(result.message);
    } catch (e) {
      setToast(e instanceof Error ? e.message : translate("skills.install_failed"));
    } finally {
      setInstallingSkillCreator(false);
    }
  };

  const installFromHub = async (skill: HubSkillCard) => {
    if (props.busy || installingHubSkill()) return;
    setInstallingHubSkill(skill.name);
    setToast(`Installing ${skill.name}…`);
    try {
      const result = await extensions.installHubSkill(skill.name);
      setToast(result.message);
    } catch (e) {
      setToast(e instanceof Error ? e.message : translate("skills.install_failed"));
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
    // Open a new session and preselect /skill-creator.
    await Promise.resolve(props.createSessionAndOpen());
    props.setPrompt("/skill-creator");
  };

  const openShareLink = (skill: SkillCard) => {
    if (props.busy) return;
    setShareTarget(skill);
    setShareBusy(false);
    setShareUrl(null);
    setShareError(null);
  };

  const closeShareLink = () => {
    setShareTarget(null);
    setShareBusy(false);
    setShareUrl(null);
    setShareError(null);
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
        setToast("Link copied");
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
      setToast("Link copied");
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

  const workspaceLabel = createMemo(() => props.workspaceName.trim() || "Worker");

  const canCreateInChat = createMemo(
    () => !props.busy && (props.canInstallSkillCreator || props.canUseDesktopTools)
  );

  const showInstalledSection = createMemo(() => activeFilter() !== "hub");
  const showHubSection = createMemo(() => activeFilter() !== "installed");

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
      setToast(translate("skills.desktop_required"));
      return;
    }
    void Promise.resolve(action());
  };

  const refreshCatalogs = () => {
    if (props.busy) return;
    void extensions.refreshSkills({ force: true });
    void extensions.refreshHubSkills({ force: true });
  };

  return (
    <section class="space-y-8">
      <Show when={toast()}>
        <div class="fixed bottom-6 right-6 z-50 max-w-sm rounded-xl border border-dls-border bg-dls-surface px-4 py-3 text-xs text-dls-text shadow-2xl">
          {toast()}
        </div>
      </Show>

      <div class="space-y-6">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div class="min-w-0">
            <p class="mb-1 text-[12px] text-dls-secondary truncate">{workspaceLabel()}</p>
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
              placeholder="Search installed or Hub skills"
              class="w-full rounded-xl border border-dls-border bg-dls-surface py-3 pl-11 pr-4 text-[14px] text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.12)]"
            />
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <For each={["all", "installed", "hub"] as SkillsFilter[]}>
              {(filter) => (
                <button
                  type="button"
                  onClick={() => setActiveFilter(filter)}
                  class={activeFilter() === filter ? pillPrimaryClass : pillGhostClass}
                >
                  {filter === "all" ? "All" : filter === "installed" ? "Installed" : "Hub"}
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
                          <div class="mt-3 truncate text-[12px] font-mono text-dls-secondary">{skill.path}</div>
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
                                if (!props.canUseDesktopTools) setToast(translate("skills.desktop_required"));
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
                <div class="text-xs text-dls-secondary truncate">{selectedSkill()!.path}</div>
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

              <div class="mt-4 rounded-xl bg-dls-hover border border-dls-border p-3 text-xs text-dls-secondary font-mono break-all">
                {uninstallTarget()?.path}
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
        <div class="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="bg-dls-surface border border-dls-border w-full max-w-md rounded-2xl shadow-2xl overflow-hidden">
            <div class="p-6 space-y-4">
              <div>
                <h3 class="text-lg font-semibold text-dls-text">Share link</h3>
                <p class="text-sm text-dls-secondary mt-1">
                  Publish a public link. Anyone with the URL can install this skill.
                </p>
              </div>

              <div class="rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-xs text-dls-secondary">
                <div class="font-semibold text-dls-text">{shareTarget()?.name}</div>
                <div class="mt-1 font-mono break-all">Publisher: {DEFAULT_OPENWORK_PUBLISHER_BASE_URL}</div>
              </div>

              <Show when={shareError()}>
                <div class="rounded-xl border border-red-7/20 bg-red-1/40 px-4 py-3 text-xs text-red-12">
                  {shareError()}
                </div>
              </Show>

              <Show
                when={shareUrl()}
                fallback={
                  <div class="flex justify-end gap-2">
                    <Button variant="outline" onClick={closeShareLink} disabled={shareBusy()}>
                      {translate("common.cancel")}
                    </Button>
                    <Button variant="secondary" onClick={() => void publishShareLink()} disabled={shareBusy()}>
                      {shareBusy() ? "Publishing…" : "Create link"}
                    </Button>
                  </div>
                }
              >
                <div class="flex items-start gap-2 rounded-xl bg-dls-hover border border-dls-border p-3">
                  <div class="min-w-0 flex-1 text-xs text-dls-secondary font-mono break-all">{shareUrl()}</div>
                  <Button
                    variant="outline"
                    onClick={() => void copyShareLink()}
                    disabled={!shareUrl()}
                  >
                    <Copy size={14} />
                    Copy link
                  </Button>
                </div>
                <div class="flex justify-end gap-2">
                  <Button variant="secondary" onClick={closeShareLink}>
                    Done
                  </Button>
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
