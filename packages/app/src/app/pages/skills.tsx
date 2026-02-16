import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import type { HubSkillCard, SkillCard } from "../types";

import Button from "../components/button";
import { Edit2, FolderOpen, Link2, Loader2, Package, Plus, RefreshCw, Search, Sparkles, Trash2, Upload } from "lucide-solid";
import { currentLocale, t } from "../../i18n";
import { DEFAULT_OPENWORK_PUBLISHER_BASE_URL, publishOpenworkBundleJson } from "../lib/publisher";

type InstallResult = { ok: boolean; message: string };

type SkillBundleV1 = {
  schemaVersion: 1;
  type: "skill";
  name: string;
  content: string;
  description?: string;
  trigger?: string;
};

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
  canInstallSkillCreator: boolean;
  canUseDesktopTools: boolean;
  accessHint?: string | null;
  refreshSkills: (options?: { force?: boolean }) => void;
  refreshHubSkills: (options?: { force?: boolean }) => void;
  skills: SkillCard[];
  skillsStatus: string | null;
  hubSkills: HubSkillCard[];
  hubSkillsStatus: string | null;
  importLocalSkill: () => void;
  installSkillCreator: () => Promise<InstallResult>;
  installHubSkill: (name: string) => Promise<InstallResult>;
  revealSkillsFolder: () => void;
  uninstallSkill: (name: string) => void;
  readSkill: (name: string) => Promise<{ name: string; path: string; content: string } | null>;
  saveSkill: (input: { name: string; content: string; description?: string }) => void;
  createSessionAndOpen: () => void;
  setPrompt: (value: string) => void;
};

export default function SkillsView(props: SkillsViewProps) {
  // Translation helper that uses current language from i18n
  const translate = (key: string) => t(key, currentLocale());

  const skillCreatorInstalled = createMemo(() =>
    props.skills.some((skill) => skill.name === "skill-creator")
  );

  const [uninstallTarget, setUninstallTarget] = createSignal<SkillCard | null>(null);
  const uninstallOpen = createMemo(() => uninstallTarget() != null);
  const [searchQuery, setSearchQuery] = createSignal("");

  const [shareTarget, setShareTarget] = createSignal<SkillCard | null>(null);
  const shareOpen = createMemo(() => shareTarget() != null);
  const [shareBusy, setShareBusy] = createSignal(false);
  const [shareUrl, setShareUrl] = createSignal<string | null>(null);
  const [shareError, setShareError] = createSignal<string | null>(null);

  const [installLinkOpen, setInstallLinkOpen] = createSignal(false);
  const [installLinkUrl, setInstallLinkUrl] = createSignal("");
  const [installLinkBusy, setInstallLinkBusy] = createSignal(false);
  const [installLinkError, setInstallLinkError] = createSignal<string | null>(null);
  const [installLinkBundle, setInstallLinkBundle] = createSignal<SkillBundleV1 | null>(null);

  const [selectedSkill, setSelectedSkill] = createSignal<SkillCard | null>(null);
  const [selectedContent, setSelectedContent] = createSignal("");
  const [selectedLoading, setSelectedLoading] = createSignal(false);
  const [selectedDirty, setSelectedDirty] = createSignal(false);
  const [selectedError, setSelectedError] = createSignal<string | null>(null);

  const [toast, setToast] = createSignal<string | null>(null);
  const [installingSkillCreator, setInstallingSkillCreator] = createSignal(false);
  const [installingHubSkill, setInstallingHubSkill] = createSignal<string | null>(null);

  onMount(() => {
    props.refreshHubSkills();
  });

  createEffect(() => {
    const message = toast();
    if (!message) return;
    const id = window.setTimeout(() => setToast(null), 2400);
    onCleanup(() => window.clearTimeout(id));
  });

  const maskError = (value: unknown) => (value instanceof Error ? value.message : "Something went wrong");

  const stripFrontmatter = (content: string) => {
    const raw = String(content ?? "");
    const match = raw.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/);
    if (!match) return raw;
    return raw.slice(match[0].length);
  };

  const resolveUniqueSkillName = (base: string, taken: Set<string>) => {
    const trimmed = String(base ?? "").trim();
    if (!trimmed) return "";
    if (!taken.has(trimmed)) return trimmed;
    for (let i = 2; i < 1_000; i++) {
      const candidate = `${trimmed}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${trimmed}-${Date.now()}`;
  };

  const filteredSkills = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    if (!query) return props.skills;
    return props.skills.filter((skill) => {
      const description = skill.description ?? "";
      return (
        skill.name.toLowerCase().includes(query) ||
        description.toLowerCase().includes(query)
      );
    });
  });

  const installedNames = createMemo(() => new Set(props.skills.map((skill) => skill.name)));

  const availableHubSkills = createMemo(() =>
    props.hubSkills.filter((skill) => !installedNames().has(skill.name))
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
      const result = await props.installSkillCreator();
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
      const result = await props.installHubSkill(skill.name);
      setToast(result.message);
    } catch (e) {
      setToast(e instanceof Error ? e.message : translate("skills.install_failed"));
    } finally {
      setInstallingHubSkill(null);
    }
  };

  const recommendedSkills = createMemo(() => {
    const items: Array<{
      id: string;
      title: string;
      description: string;
      icon: any;
      onClick: () => void | Promise<void>;
      disabled: boolean;
    }> = [
      {
        id: "import-local",
        title: translate("skills.import_local"),
        description: translate("skills.import_local_hint"),
        icon: Upload,
        onClick: props.importLocalSkill,
        disabled: props.busy || !props.canUseDesktopTools,
      },
      {
        id: "reveal-folder",
        title: translate("skills.reveal_folder"),
        description: translate("skills.reveal_folder_hint"),
        icon: FolderOpen,
        onClick: props.revealSkillsFolder,
        disabled: props.busy || !props.canUseDesktopTools,
      },
    ];

    if (!skillCreatorInstalled()) {
      items.unshift({
        id: "skill-creator",
        title: translate("skills.install_skill_creator"),
        description: translate("skills.install_skill_creator_hint"),
        icon: Sparkles,
        onClick: installSkillCreator,
        disabled: props.busy || installingSkillCreator() || !props.canInstallSkillCreator,
      });
    }

    return items;
  });

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
      const skill = await props.readSkill(target.name);
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

  const openInstallFromLink = () => {
    if (props.busy) return;
    setInstallLinkOpen(true);
    setInstallLinkUrl("");
    setInstallLinkBusy(false);
    setInstallLinkError(null);
    setInstallLinkBundle(null);
  };

  const closeInstallFromLink = () => {
    setInstallLinkOpen(false);
    setInstallLinkBusy(false);
    setInstallLinkError(null);
    setInstallLinkBundle(null);
  };

  const previewInstallLink = async () => {
    const raw = installLinkUrl().trim();
    if (!raw) {
      setInstallLinkError("Paste a link to preview");
      return;
    }
    if (installLinkBusy()) return;

    setInstallLinkBusy(true);
    setInstallLinkError(null);
    setInstallLinkBundle(null);
    try {
      const url = new URL(raw);
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(url.toString(), {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          const text = (await response.text()).trim();
          const suffix = text ? `: ${text}` : "";
          throw new Error(`Failed to fetch bundle (${response.status})${suffix}`);
        }
        const json = (await response.json()) as Record<string, unknown>;
        const schemaVersion = typeof json.schemaVersion === "number" ? json.schemaVersion : null;
        const type = typeof json.type === "string" ? json.type : "";
        const name = typeof json.name === "string" ? json.name.trim() : "";
        const content = typeof json.content === "string" ? json.content : "";
        if (schemaVersion !== 1 || type !== "skill") {
          throw new Error("This link is not an OpenWork skill bundle");
        }
        if (!name) throw new Error("Bundle is missing a skill name");
        if (!content) throw new Error("Bundle is missing skill content");
        setInstallLinkBundle({
          schemaVersion: 1,
          type: "skill",
          name,
          content,
          description: typeof json.description === "string" ? json.description : undefined,
          trigger: typeof json.trigger === "string" ? json.trigger : undefined,
        });
      } finally {
        window.clearTimeout(timer);
      }
    } catch (e) {
      setInstallLinkError(maskError(e));
    } finally {
      setInstallLinkBusy(false);
    }
  };

  const installFromPreview = async (mode: "overwrite" | "keep-both") => {
    const bundle = installLinkBundle();
    if (!bundle) return;
    if (props.busy || installLinkBusy()) return;
    setInstallLinkBusy(true);
    setInstallLinkError(null);

    try {
      const taken = installedNames();
      const desiredName = bundle.name.trim();
      const conflict = taken.has(desiredName);
      const shouldRename = conflict && mode === "keep-both";
      const finalName = shouldRename ? resolveUniqueSkillName(desiredName, taken) : desiredName;
      const content = shouldRename ? stripFrontmatter(bundle.content) : bundle.content;

      await Promise.resolve(
        props.saveSkill({
          name: finalName,
          content,
          description: bundle.description,
        }),
      );
      props.refreshSkills({ force: true });
      setToast(`Installed ${finalName}`);
      closeInstallFromLink();
    } catch (e) {
      setInstallLinkError(maskError(e));
    } finally {
      setInstallLinkBusy(false);
    }
  };

  const recommendedDisabledReason = (id: string) => {
    if (id === "skill-creator") {
      if (skillCreatorInstalled()) return translate("skills.installed_label");
      if (props.busy || installingSkillCreator()) return translate("skills.installing_skill_creator");
      if (!props.canInstallSkillCreator) {
        return props.accessHint ?? translate("skills.host_only_error");
      }
      return null;
    }

    if (!props.canUseDesktopTools) {
      return translate("skills.desktop_required");
    }

    return null;
  };

  const openSkill = async (skill: SkillCard) => {
    if (props.busy) return;
    setSelectedSkill(skill);
    setSelectedContent("");
    setSelectedDirty(false);
    setSelectedError(null);
    setSelectedLoading(true);
    try {
      const result = await props.readSkill(skill.name);
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
        props.saveSkill({
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

  const newSkillDisabled = createMemo(
    () =>
      props.busy ||
      (!props.canInstallSkillCreator && !props.canUseDesktopTools)
  );

  const workspaceLabel = createMemo(() => props.workspaceName.trim() || "Worker");

  const canCreateInChat = createMemo(
    () => !props.busy && (props.canInstallSkillCreator || props.canUseDesktopTools)
  );

  const isOpenworkInjectedSkill = (skill: SkillCard) => {
    const normalizedName = skill.name.trim().toLowerCase();
    const normalizedPath = skill.path.replace(/\\/g, "/").toLowerCase();
    const inProjectSkillPath = normalizedPath.includes("/.opencode/skills/");
    if (!inProjectSkillPath) return false;
    return OPENWORK_DEFAULT_SKILL_NAMES.has(normalizedName) || normalizedName.endsWith("-creator");
  };

  return (
    <section class="space-y-8">
      <Show when={toast()}>
        <div class="fixed bottom-6 right-6 z-50 max-w-sm rounded-xl border border-dls-border bg-dls-surface px-4 py-3 text-xs text-dls-text shadow-2xl">
          {toast()}
        </div>
      </Show>

      <div class="space-y-2">
        <h2 class="text-3xl font-bold text-dls-text">{translate("skills.title")}</h2>
        <p class="text-sm text-dls-secondary">{translate("skills.subtitle")}</p>
      </div>

      <div class="rounded-2xl border border-dls-border bg-dls-surface px-5 py-5 shadow-[0_8px_26px_rgba(17,24,39,0.05)]">
        <div class="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div class="min-w-0 space-y-1">
            <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-dls-secondary">Worker profile</div>
            <div class="text-xl font-semibold text-dls-text truncate">{workspaceLabel()}</div>
            <p class="text-sm text-dls-secondary">
              Skills are the core abilities of this worker. Add from Hub or create new ones directly in chat.
            </p>
          </div>
          <button
            type="button"
            onClick={handleNewSkill}
            disabled={!canCreateInChat()}
            class={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-medium transition-colors ${
              canCreateInChat()
                ? "bg-dls-text text-dls-surface hover:opacity-90"
                : "bg-dls-active text-dls-secondary"
            }`}
          >
            <Sparkles size={14} />
            Create skill in chat
          </button>
        </div>

        <div class="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div class="rounded-lg border border-dls-border bg-dls-hover px-3 py-2.5">
            <div class="text-[11px] text-dls-secondary">Installed</div>
            <div class="mt-1 text-base font-semibold text-dls-text">{props.skills.length}</div>
          </div>
          <div class="rounded-lg border border-dls-border bg-dls-hover px-3 py-2.5">
            <div class="text-[11px] text-dls-secondary">Hub available</div>
            <div class="mt-1 text-base font-semibold text-dls-text">{availableHubSkills().length}</div>
          </div>
          <div class="rounded-lg border border-dls-border bg-dls-hover px-3 py-2.5">
            <div class="text-[11px] text-dls-secondary">Skill creator</div>
            <div class="mt-1 text-base font-semibold text-dls-text">
              {skillCreatorInstalled() ? "Installed" : "Not installed"}
            </div>
          </div>
          <div class="rounded-lg border border-dls-border bg-dls-hover px-3 py-2.5">
            <div class="text-[11px] text-dls-secondary">Mode</div>
            <div class="mt-1 text-base font-semibold text-dls-text">
              {props.canUseDesktopTools ? "Local" : "Server"}
            </div>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-3 border-b border-dls-border pb-4">
        <button
          type="button"
          onClick={() => props.refreshSkills({ force: true })}
          disabled={props.busy}
          class={`flex items-center gap-1.5 text-xs font-medium transition-colors ${
            props.busy
              ? "text-dls-secondary"
              : "text-dls-secondary hover:text-dls-text"
          }`}
        >
          <RefreshCw size={14} />
          {translate("skills.refresh")}
        </button>
        <div class="relative">
          <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-dls-secondary" />
          <input
            type="text"
            value={searchQuery()}
            onInput={(event) => setSearchQuery(event.currentTarget.value)}
            placeholder="Search installed or hub skills"
            class="bg-dls-hover border border-dls-border rounded-lg py-1.5 pl-9 pr-4 text-xs w-56 focus:w-72 focus:outline-none transition-all"
          />
        </div>
        <button
          type="button"
          onClick={handleNewSkill}
          disabled={newSkillDisabled()}
          class={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
            newSkillDisabled()
              ? "bg-dls-active text-dls-secondary"
              : "bg-dls-text text-dls-surface hover:opacity-90"
          }`}
        >
          <Plus size={14} />
          New skill
        </button>
        <button
          type="button"
          onClick={openInstallFromLink}
          disabled={props.busy}
          class={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border ${
            props.busy
              ? "border-dls-border bg-dls-hover text-dls-secondary"
              : "border-dls-border bg-dls-surface text-dls-text hover:bg-dls-active"
          }`}
          title="Install a skill from a link"
        >
          <Link2 size={14} />
          Install from link
        </button>
      </div>

      <Show when={props.accessHint}>
        <div class="text-xs text-dls-secondary">{props.accessHint}</div>
      </Show>
      <Show
        when={!props.accessHint && !props.canInstallSkillCreator && !props.canUseDesktopTools}
      >
        <div class="text-xs text-dls-secondary">{translate("skills.host_mode_only")}</div>
      </Show>

      <Show when={props.skillsStatus}>
        <div class="rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-xs text-dls-secondary whitespace-pre-wrap break-words">
          {props.skillsStatus}
        </div>
      </Show>

      <div class="space-y-4">
        <h3 class="text-[11px] font-bold text-dls-secondary uppercase tracking-widest">
          {translate("skills.installed")}
        </h3>
        <Show
          when={filteredSkills().length}
          fallback={
            <div class="rounded-xl border border-dls-border bg-dls-surface px-5 py-6 text-sm text-dls-secondary">
              {translate("skills.no_skills")}
            </div>
          }
        >
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <For each={filteredSkills()}>
              {(skill) => (
                <div
                  role="button"
                  tabindex="0"
                  class="bg-dls-surface border border-dls-border rounded-xl p-4 flex items-start justify-between group hover:border-dls-border hover:bg-dls-hover transition-all text-left cursor-pointer"
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
                    <div class="w-10 h-10 rounded-lg flex items-center justify-center shadow-sm border border-dls-border bg-dls-surface">
                      <Package size={20} class="text-dls-secondary" />
                    </div>
                    <div class="min-w-0">
                      <div class="flex items-center gap-2 mb-0.5">
                        <h4 class="text-sm font-semibold text-dls-text truncate">{skill.name}</h4>
                        <Show when={isOpenworkInjectedSkill(skill)}>
                          <span class="rounded-full border border-dls-border bg-dls-hover px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-dls-secondary">
                            OpenWork
                          </span>
                        </Show>
                      </div>
                      <Show when={skill.description}>
                        <p class="text-xs text-dls-secondary line-clamp-1">
                          {skill.description}
                        </p>
                      </Show>
                      <div class="mt-1 text-[11px] font-mono text-dls-secondary truncate">{skill.path}</div>
                    </div>
                  </div>
                  <div class="flex items-center gap-1">
                    <button
                      type="button"
                      class="p-1.5 text-dls-secondary hover:text-dls-text hover:bg-dls-active rounded-md transition-colors"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openShareLink(skill);
                      }}
                      disabled={props.busy}
                      title="Share link"
                    >
                      <Link2 size={14} />
                    </button>
                    <button
                      type="button"
                      class="p-1.5 text-dls-secondary hover:text-dls-text hover:bg-dls-active rounded-md transition-colors"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void openSkill(skill);
                      }}
                      disabled={props.busy}
                      title="Edit"
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      type="button"
                      class={`p-1.5 rounded-md transition-colors ${
                        props.busy || !props.canUseDesktopTools
                          ? "text-dls-secondary opacity-40"
                          : "text-dls-secondary hover:text-red-11 hover:bg-red-3/10"
                      }`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (props.busy || !props.canUseDesktopTools) return;
                        setUninstallTarget(skill);
                      }}
                      disabled={props.busy || !props.canUseDesktopTools}
                      title={translate("skills.uninstall")}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="space-y-4">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-[11px] font-bold text-dls-secondary uppercase tracking-widest">Install skills</h3>
          <button
            type="button"
            onClick={() => props.refreshHubSkills({ force: true })}
            disabled={props.busy}
            class={`flex items-center gap-1.5 text-xs font-medium transition-colors ${
              props.busy
                ? "text-dls-secondary"
                : "text-dls-secondary hover:text-dls-text"
            }`}
            title="Refresh hub catalog"
          >
            <RefreshCw size={14} />
            Refresh hub
          </button>
        </div>

        <Show when={props.hubSkillsStatus}>
          <div class="rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-xs text-dls-secondary whitespace-pre-wrap break-words">
            {props.hubSkillsStatus}
          </div>
        </Show>

        <Show
          when={filteredHubSkills().length}
          fallback={
            <div class="rounded-xl border border-dls-border bg-dls-surface px-5 py-6 text-sm text-dls-secondary">
              No hub skills available.
            </div>
          }
        >
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <For each={filteredHubSkills()}>
              {(skill) => (
                <div class="bg-dls-surface border border-dls-border rounded-xl p-4 flex items-start justify-between gap-4 group hover:border-dls-border hover:bg-dls-hover transition-all text-left">
                  <div class="flex gap-4 min-w-0">
                    <div class="w-10 h-10 rounded-lg flex items-center justify-center shadow-sm border border-dls-border bg-dls-surface">
                      <Package size={20} class="text-dls-secondary" />
                    </div>
                    <div class="min-w-0">
                      <div class="flex items-center gap-2 mb-0.5">
                        <h4 class="text-sm font-semibold text-dls-text truncate">{skill.name}</h4>
                      </div>
                      <Show when={skill.description} fallback={<p class="text-xs text-dls-secondary">From openwork-hub</p>}>
                        <p class="text-xs text-dls-secondary line-clamp-2">{skill.description}</p>
                      </Show>
                      <div class="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-dls-secondary">
                        <span class="rounded-md border border-dls-border bg-dls-hover px-2 py-1 font-mono">
                          {skill.source.owner}/{skill.source.repo}
                        </span>
                        <Show when={skill.trigger}>
                          <span class="rounded-md border border-dls-border bg-dls-hover px-2 py-1 line-clamp-1">
                            Trigger: {skill.trigger}
                          </span>
                        </Show>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    class={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                      props.busy || installingHubSkill() === skill.name
                        ? "border-dls-border bg-dls-hover text-dls-secondary"
                        : "border-dls-border bg-dls-surface text-dls-text hover:bg-dls-active"
                    }`}
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
                    {installingHubSkill() === skill.name ? "Installing" : "Add"}
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="space-y-4">
        <h3 class="text-[11px] font-bold text-dls-secondary uppercase tracking-widest">Capability setup</h3>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <For each={recommendedSkills()}>
            {(item) => (
              <div
                role="button"
                tabindex="0"
                class={`bg-dls-surface border border-dls-border rounded-xl p-4 flex items-start justify-between group transition-all text-left ${
                  item.disabled ? "opacity-80" : "hover:border-dls-border hover:bg-dls-hover"
                }`}
                onClick={() => {
                  if (item.disabled) {
                    const reason = recommendedDisabledReason(item.id);
                    if (reason) setToast(reason);
                    return;
                  }
                  void item.onClick();
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  if (e.isComposing || e.keyCode === 229) return;
                  e.preventDefault();
                  if (item.disabled) {
                    const reason = recommendedDisabledReason(item.id);
                    if (reason) setToast(reason);
                    return;
                  }
                  void item.onClick();
                }}
                title={item.disabled ? (recommendedDisabledReason(item.id) ?? item.title) : item.title}
              >
                <div class="flex gap-4 min-w-0">
                  <div class="w-10 h-10 rounded-lg flex items-center justify-center shadow-sm border border-dls-border bg-dls-hover">
                    <item.icon size={20} class="text-dls-secondary" />
                  </div>
                  <div class="min-w-0">
                    <div class="flex items-center gap-2 mb-0.5">
                      <h4 class="text-sm font-semibold text-dls-text truncate">{item.title}</h4>
                    </div>
                    <p class="text-xs text-dls-secondary line-clamp-2">{item.description}</p>
                    <Show when={item.id === "skill-creator" && !props.canInstallSkillCreator && !skillCreatorInstalled()}>
                      <div class="mt-1 text-[11px] text-dls-secondary">
                        {props.accessHint ?? translate("skills.host_only_error")}
                      </div>
                    </Show>
                  </div>
                </div>
                <button
                  type="button"
                  class={`p-1.5 rounded-md transition-colors ${
                    item.disabled
                      ? "text-dls-secondary opacity-40"
                      : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
                  }`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (item.disabled) {
                      const reason = recommendedDisabledReason(item.id);
                      if (reason) setToast(reason);
                      return;
                    }
                    void item.onClick();
                  }}
                  disabled={item.disabled}
                  title={item.title}
                >
                  <Show
                    when={item.id === "skill-creator" && installingSkillCreator()}
                    fallback={<Plus size={16} />}
                  >
                    <Loader2 size={16} class="animate-spin" />
                  </Show>
                </button>
              </div>
            )}
          </For>
        </div>
      </div>

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
                    props.uninstallSkill(target.name);
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
                <div class="rounded-xl bg-dls-hover border border-dls-border p-3 text-xs text-dls-secondary font-mono break-all">
                  {shareUrl()}
                </div>
                <div class="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void navigator.clipboard.writeText(shareUrl() ?? "")}
                    disabled={!shareUrl()}
                  >
                    Copy link
                  </Button>
                  <Button variant="secondary" onClick={closeShareLink}>
                    Done
                  </Button>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <Show when={installLinkOpen()}>
        <div class="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="bg-dls-surface border border-dls-border w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden">
            <div class="p-6 space-y-4">
              <div>
                <h3 class="text-lg font-semibold text-dls-text">Install from link</h3>
                <p class="text-sm text-dls-secondary mt-1">Paste a skill bundle URL, preview it, then install.</p>
              </div>

              <div class="space-y-2">
                <div class="text-xs font-semibold uppercase tracking-widest text-dls-secondary">Link</div>
                <input
                  type="url"
                  value={installLinkUrl()}
                  onInput={(e) => setInstallLinkUrl(e.currentTarget.value)}
                  placeholder="https://share.openwork.software/b/..."
                  class="w-full bg-dls-hover border border-dls-border rounded-lg px-3 py-2 text-xs font-mono text-dls-text focus:outline-none"
                  spellcheck={false}
                />
              </div>

              <Show when={installLinkError()}>
                <div class="rounded-xl border border-red-7/20 bg-red-1/40 px-4 py-3 text-xs text-red-12">
                  {installLinkError()}
                </div>
              </Show>

              <Show when={installLinkBundle()}>
                {(bundle) => {
                  const taken = installedNames();
                  const conflict = taken.has(bundle().name.trim());
                  return (
                    <div class="rounded-xl border border-dls-border bg-dls-hover p-4 space-y-2">
                      <div class="text-xs font-semibold text-dls-text">Preview</div>
                      <div class="text-xs text-dls-secondary">
                        Skill: <span class="font-mono">{bundle().name}</span>
                      </div>
                      <Show when={bundle().description}>
                        <div class="text-xs text-dls-secondary">{bundle().description}</div>
                      </Show>
                      <Show when={conflict}>
                        <div class="text-xs text-amber-11">A skill with this name is already installed.</div>
                      </Show>
                    </div>
                  );
                }}
              </Show>

              <div class="flex justify-end gap-2">
                <Button variant="outline" onClick={closeInstallFromLink} disabled={installLinkBusy()}>
                  {translate("common.cancel")}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void previewInstallLink()}
                  disabled={installLinkBusy() || !installLinkUrl().trim()}
                >
                  {installLinkBusy() && !installLinkBundle() ? "Loading…" : "Preview"}
                </Button>
                <Show when={installLinkBundle()} keyed>
                  {(bundle) => {
                    const conflict = installedNames().has(bundle.name.trim());
                    return (
                      <Show
                        when={conflict}
                        fallback={
                          <Button
                            variant="secondary"
                            onClick={() => void installFromPreview("overwrite")}
                            disabled={installLinkBusy()}
                          >
                            {installLinkBusy() ? "Installing…" : "Install"}
                          </Button>
                        }
                      >
                        <div class="flex gap-2">
                          <Button
                            variant="outline"
                            onClick={() => void installFromPreview("keep-both")}
                            disabled={installLinkBusy()}
                          >
                            {installLinkBusy() ? "Installing…" : "Keep both"}
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() => void installFromPreview("overwrite")}
                            disabled={installLinkBusy()}
                          >
                            {installLinkBusy() ? "Installing…" : "Overwrite"}
                          </Button>
                        </div>
                      </Show>
                    );
                  }}
                </Show>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </section>
  );
}
