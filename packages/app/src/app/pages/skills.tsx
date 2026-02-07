import { For, Show, createMemo, createSignal } from "solid-js";

import type { SkillCard } from "../types";

import Button from "../components/button";
import { Edit2, FolderOpen, Package, Plus, RefreshCw, Search, Sparkles, Trash2, Upload } from "lucide-solid";
import { currentLocale, t } from "../../i18n";

export type SkillsViewProps = {
  busy: boolean;
  canInstallSkillCreator: boolean;
  canUseDesktopTools: boolean;
  accessHint?: string | null;
  refreshSkills: (options?: { force?: boolean }) => void;
  skills: SkillCard[];
  skillsStatus: string | null;
  importLocalSkill: () => void;
  installSkillCreator: () => void;
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

  const [selectedSkill, setSelectedSkill] = createSignal<SkillCard | null>(null);
  const [selectedContent, setSelectedContent] = createSignal("");
  const [selectedLoading, setSelectedLoading] = createSignal(false);
  const [selectedDirty, setSelectedDirty] = createSignal(false);
  const [selectedError, setSelectedError] = createSignal<string | null>(null);

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

  const recommendedSkills = createMemo(() => [
    {
      id: "skill-creator",
      title: translate("skills.install_skill_creator"),
      description: translate("skills.install_skill_creator_hint"),
      icon: Sparkles,
      onClick: () => props.installSkillCreator(),
      disabled: props.busy || skillCreatorInstalled() || !props.canInstallSkillCreator,
    },
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
  ]);

  const handleNewSkill = async () => {
    if (props.busy) return;
    // Ensure skill-creator exists when we can.
    if (props.canInstallSkillCreator && !skillCreatorInstalled()) {
      await Promise.resolve(props.installSkillCreator());
    }
    // Open a new session and preselect /skill-creator.
    await Promise.resolve(props.createSessionAndOpen());
    props.setPrompt("/skill-creator");
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

  return (
    <section class="space-y-10">
      <div class="flex flex-wrap items-center justify-end gap-4 border-b border-dls-border pb-4">
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
            placeholder="Search skills"
            class="bg-dls-hover border border-dls-border rounded-lg py-1.5 pl-9 pr-4 text-xs w-48 focus:w-64 focus:outline-none transition-all"
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
      </div>

      <div class="space-y-2">
        <h2 class="text-3xl font-bold text-dls-text">{translate("skills.title")}</h2>
        <p class="text-sm text-dls-secondary">
          {translate("skills.subtitle")} {" "}
          <button type="button" class="text-dls-accent hover:underline">
            Learn more
          </button>
        </p>
        <Show when={props.accessHint}>
          <div class="text-xs text-dls-secondary">{props.accessHint}</div>
        </Show>
        <Show
          when={!props.accessHint && !props.canInstallSkillCreator && !props.canUseDesktopTools}
        >
          <div class="text-xs text-dls-secondary">{translate("skills.host_mode_only")}</div>
        </Show>
      </div>

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
                  <div class="flex gap-4">
                    <div class="w-10 h-10 rounded-lg flex items-center justify-center shadow-sm border border-dls-border bg-dls-surface">
                      <Package size={20} class="text-dls-secondary" />
                    </div>
                    <div>
                      <div class="flex items-center gap-2 mb-0.5">
                        <h4 class="text-sm font-semibold text-dls-text">{skill.name}</h4>
                      </div>
                      <Show when={skill.description}>
                        <p class="text-xs text-dls-secondary line-clamp-1">
                          {skill.description}
                        </p>
                      </Show>
                    </div>
                  </div>
                  <div class="flex items-center gap-1">
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

      <div class="space-y-4">
        <h3 class="text-[11px] font-bold text-dls-secondary uppercase tracking-widest">Recommended</h3>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <For each={recommendedSkills()}>
            {(item) => (
              <div class="bg-dls-surface border border-dls-border rounded-xl p-4 flex items-start justify-between group hover:border-dls-border transition-all">
                <div class="flex gap-4">
                  <div class="w-10 h-10 rounded-lg flex items-center justify-center shadow-sm border border-dls-border bg-dls-hover">
                    <item.icon size={20} class="text-dls-secondary" />
                  </div>
                  <div>
                    <div class="flex items-center gap-2 mb-0.5">
                      <h4 class="text-sm font-semibold text-dls-text">{item.title}</h4>
                    </div>
                    <p class="text-xs text-dls-secondary line-clamp-1">{item.description}</p>
                  </div>
                </div>
                <button
                  type="button"
                  class={`p-1.5 rounded-md transition-colors ${
                    item.disabled
                      ? "text-dls-secondary opacity-40"
                      : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
                  }`}
                  onClick={() => {
                    if (item.disabled) return;
                    item.onClick();
                  }}
                  disabled={item.disabled}
                  title={item.title}
                >
                  <Plus size={16} />
                </button>
              </div>
            )}
          </For>
        </div>
      </div>

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
    </section>
  );
}
