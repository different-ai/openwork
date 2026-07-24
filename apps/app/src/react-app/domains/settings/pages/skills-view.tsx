/** @jsxImportSource react */
import {
  useCallback,
  useMemo,
  useReducer,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction,
} from "react";
import {
  Edit2,
  FolderOpen,
  Package,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "@/components/ui/sonner";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/i18n";
import type { SkillCard } from "@/app/types";
import {
  pillGhostClass,
  pillPrimaryClass,
  pillSecondaryClass,
  tagClass,
} from "@/react-app/domains/workspace/modal-styles";
import { Button } from "@/components/ui/button";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { isOpenworkProvidedSkill } from "../extension-items";

type InstallResult = { ok: boolean; message: string };
type SkillsFilter = "all" | "installed";

const pageTitleClass = "text-[28px] font-semibold tracking-[-0.5px] text-dls-text";
const sectionTitleClass = "text-[15px] font-medium tracking-[-0.2px] text-dls-text";
const panelCardClass =
  "rounded-[20px] border border-dls-border bg-dls-surface p-5 transition-all hover:border-dls-border hover:shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)]";

export type SkillsExtensionsStore = {
  skills: () => SkillCard[];
  skillsStatus: () => string | null;
  refreshSkills: (options?: { force?: boolean }) => void | Promise<void>;
  installSkillCreator: () => Promise<InstallResult>;
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
  createSessionAndOpen: (initialPrompt?: string) => Promise<string | undefined> | string | void;
};

type SkillsViewLocalState = {
  uninstallTarget: SkillCard | null;
  searchQuery: string;
  activeFilter: SkillsFilter;
  selectedSkill: SkillCard | null;
  selectedContent: string;
  selectedLoading: boolean;
  selectedDirty: boolean;
  selectedError: string | null;
  installingSkillCreator: boolean;
};

type SkillsViewLocalAction<K extends keyof SkillsViewLocalState = keyof SkillsViewLocalState> =
  { type: "set"; key: K; value: SetStateAction<any> };

const initialSkillsViewLocalState: SkillsViewLocalState = {
  uninstallTarget: null,
  searchQuery: "",
  activeFilter: "all",
  selectedSkill: null,
  selectedContent: "",
  selectedLoading: false,
  selectedDirty: false,
  selectedError: null,
  installingSkillCreator: false,
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
    selectedSkill,
    selectedContent,
    selectedLoading,
    selectedDirty,
    selectedError,
    installingSkillCreator,
  } = localState;
  const setLocal = <K extends keyof SkillsViewLocalState>(
    key: K,
    value: SetStateAction<SkillsViewLocalState[K]>,
  ) => dispatchLocal({ type: "set", key, value });
  const setUninstallTarget = (value: SetStateAction<SkillCard | null>) => setLocal("uninstallTarget", value);
  const setSearchQuery = (value: SetStateAction<string>) => setLocal("searchQuery", value);
  const setActiveFilter = (value: SetStateAction<SkillsFilter>) => setLocal("activeFilter", value);
  const setSelectedSkill = (value: SetStateAction<SkillCard | null>) => setLocal("selectedSkill", value);
  const setSelectedContent = (value: SetStateAction<string>) => setLocal("selectedContent", value);
  const setSelectedLoading = (value: SetStateAction<boolean>) => setLocal("selectedLoading", value);
  const setSelectedDirty = (value: SetStateAction<boolean>) => setLocal("selectedDirty", value);
  const setSelectedError = (value: SetStateAction<string | null>) => setLocal("selectedError", value);
  const setInstallingSkillCreator = (value: SetStateAction<boolean>) => setLocal("installingSkillCreator", value);

  const maskError = useCallback(
    (value: unknown) =>
      value instanceof Error ? value.message : t("common.something_went_wrong"),
    [],
  );

  const skills = extensions.skills();
  const skillsStatus = extensions.skillsStatus();

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

  const showInstalledSection = activeFilter === "all" || activeFilter === "installed";
  const canCreateInChat = !props.busy && (props.canInstallSkillCreator || props.canUseDesktopTools);

  const runDesktopAction = useCallback(
    (action: () => void | Promise<void>) => {
      if (props.busy) return;
      if (!props.canUseDesktopTools) {
        toast.warning(t("skills.desktop_required"));
        return;
      }
      void Promise.resolve(action());
    },
    [props.busy, props.canUseDesktopTools],
  );

  const refreshCatalogs = useCallback(() => {
    if (props.busy) return;
    void extensions.refreshSkills({ force: true });
  }, [extensions, props.busy]);

  const installSkillCreator = useCallback(async () => {
    if (props.busy || installingSkillCreator) return;
    if (!props.canInstallSkillCreator) {
      toast.warning(props.accessHint ?? t("skills.host_only_error"));
      return;
    }
    setInstallingSkillCreator(true);
    toast.info(t("skills.installing_skill_creator"));
    try {
      const result = await extensions.installSkillCreator();
      toast.success(result.message);
    } catch (error) {
      toast.error(maskError(error));
    } finally {
      setInstallingSkillCreator(false);
    }
  }, [extensions, installingSkillCreator, maskError, props.accessHint, props.busy, props.canInstallSkillCreator]);

  const handleNewSkill = useCallback(async () => {
    if (props.busy) return;
    if (props.canInstallSkillCreator && !skillCreatorInstalled) {
      await installSkillCreator();
    }
    await Promise.resolve(props.createSessionAndOpen("/skill-creator"));
  }, [installSkillCreator, props, skillCreatorInstalled]);

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
            {(["all", "installed"] as SkillsFilter[]).map((filter) => (
              <button
                key={filter}
                type="button"
                onClick={() => setActiveFilter(filter)}
                className={activeFilter === filter ? pillPrimaryClass : pillGhostClass}
              >
                {filter === "all"
                  ? t("skills.filter_all")
                  : t("skills.filter_installed")}
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
                          {isOpenworkProvidedSkill(skill) ? <span className={tagClass}>OpenWork</span> : null}
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
                              if (!props.canUseDesktopTools) toast.warning(t("skills.desktop_required"));
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

    </section>
  );
}

export default SkillsView;
