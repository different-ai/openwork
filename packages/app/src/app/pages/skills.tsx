import { For, Show, createMemo, createSignal } from "solid-js";

import type { RemoteSkillCard, RemoteSkillSource, SkillCard } from "../types";

import Button from "../components/button";
import TextInput from "../components/text-input";
import { FolderOpen, Package, Upload } from "lucide-solid";
import { currentLocale, t } from "../../i18n";

export type SkillsViewProps = {
  busy: boolean;
  mode: "host" | "client" | null;
  canInstallSkillCreator: boolean;
  canUseDesktopTools: boolean;
  accessHint?: string | null;
  remoteAccessHint?: string | null;
  canBrowseRemoteSkills: boolean;
  canInstallRemoteSkills: boolean;
  refreshSkills: (options?: { force?: boolean }) => void;
  refreshRemoteSkills: (options?: { force?: boolean }) => void;
  skills: SkillCard[];
  skillsStatus: string | null;
  remoteSkillSources: RemoteSkillSource[];
  remoteSkills: RemoteSkillCard[];
  remoteSkillsStatus: string | null;
  remoteSkillsLoading: boolean;
  remoteSkillInstallState: Record<string, { status: "idle" | "installing" | "error"; message?: string | null }>;
  addRemoteSkillSource: (input: string) => Promise<boolean> | boolean;
  removeRemoteSkillSource: (id: string) => void;
  installRemoteSkill: (skill: RemoteSkillCard) => void;
  importLocalSkill: () => void;
  installSkillCreator: () => void;
  revealSkillsFolder: () => void;
  uninstallSkill: (name: string) => void;
};

export default function SkillsView(props: SkillsViewProps) {
  // Translation helper that uses current language from i18n
  const translate = (key: string) => t(key, currentLocale());

  const skillCreatorInstalled = createMemo(() =>
    props.skills.some((skill) => skill.name === "skill-creator")
  );

  const [uninstallTarget, setUninstallTarget] = createSignal<SkillCard | null>(null);
  const uninstallOpen = createMemo(() => uninstallTarget() != null);
  const [remoteSourceInput, setRemoteSourceInput] = createSignal("");
  const [remoteSourceBusy, setRemoteSourceBusy] = createSignal(false);

  const installedNames = createMemo(() => new Set(props.skills.map((skill) => skill.name)));
  const remoteSkillsBySource = createMemo(() => {
    const map = new Map<string, RemoteSkillCard[]>();
    for (const skill of props.remoteSkills) {
      const list = map.get(skill.sourceId) ?? [];
      list.push(skill);
      map.set(skill.sourceId, list);
    }
    for (const [key, list] of map.entries()) {
      map.set(
        key,
        [...list].sort((a, b) => a.name.localeCompare(b.name)),
      );
    }
    return map;
  });

  const addRemoteSource = async () => {
    if (remoteSourceBusy()) return;
    const value = remoteSourceInput().trim();
    if (!value) return;
    setRemoteSourceBusy(true);
    try {
      const result = await props.addRemoteSkillSource(value);
      if (result) {
        setRemoteSourceInput("");
      }
    } finally {
      setRemoteSourceBusy(false);
    }
  };

  return (
    <section class="space-y-8">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 class="text-lg font-semibold text-gray-12">{translate("skills.title")}</h3>
          <p class="text-sm text-gray-10 mt-1">{translate("skills.subtitle")}</p>
        </div>
        <Button variant="secondary" onClick={() => props.refreshSkills({ force: true })} disabled={props.busy}>
          {translate("skills.refresh")}
        </Button>
      </div>

      <div class="rounded-2xl border border-gray-6/60 bg-gray-1/40 overflow-hidden">
        <div class="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-gray-6/60 bg-gray-2/40">
          <div>
            <div class="text-xs font-semibold text-gray-11 uppercase tracking-wider">{translate("skills.add_title")}</div>
            <div class="text-sm text-gray-10 mt-2">{translate("skills.add_description")}</div>
          </div>
          <Show when={props.accessHint}>
            <div class="text-xs text-gray-10">{props.accessHint}</div>
          </Show>
          <Show
            when={
              !props.accessHint &&
              props.mode !== "host" &&
              !props.canInstallSkillCreator &&
              !props.canUseDesktopTools
            }
          >
            <div class="text-xs text-gray-10">{translate("skills.host_mode_only")}</div>
          </Show>
        </div>

        <div class="divide-y divide-gray-6/60">
          <div class="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div>
              <div class="text-sm font-medium text-gray-12">{translate("skills.install_skill_creator")}</div>
              <div class="text-xs text-gray-10 mt-1">{translate("skills.install_skill_creator_hint")}</div>
            </div>
            <Button
              variant={skillCreatorInstalled() ? "outline" : "secondary"}
              onClick={() => {
                if (skillCreatorInstalled()) return;
                props.installSkillCreator();
              }}
              disabled={props.busy || skillCreatorInstalled() || !props.canInstallSkillCreator}
            >
              <Package size={16} />
              {skillCreatorInstalled() ? translate("skills.installed_label") : translate("skills.install")}
            </Button>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div>
              <div class="text-sm font-medium text-gray-12">{translate("skills.import_local")}</div>
              <div class="text-xs text-gray-10 mt-1">{translate("skills.import_local_hint")}</div>
            </div>
            <Button
              variant="secondary"
              onClick={props.importLocalSkill}
              disabled={props.busy || !props.canUseDesktopTools}
            >
              <Upload size={16} />
              {translate("skills.import")}
            </Button>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div>
              <div class="text-sm font-medium text-gray-12">{translate("skills.reveal_folder")}</div>
              <div class="text-xs text-gray-10 mt-1">{translate("skills.reveal_folder_hint")}</div>
            </div>
            <Button
              variant="secondary"
              onClick={props.revealSkillsFolder}
              disabled={props.busy || !props.canUseDesktopTools}
            >
              <FolderOpen size={16} />
              {translate("skills.reveal_button")}
            </Button>
          </div>
        </div>

        <Show when={props.skillsStatus}>
          <div class="border-t border-gray-6/60 px-5 py-3 text-xs text-gray-11 whitespace-pre-wrap break-words">
            {props.skillsStatus}
          </div>
        </Show>
      </div>

      <div class="rounded-2xl border border-gray-6/60 bg-gray-1/40 overflow-hidden">
        <div class="flex flex-wrap items-start justify-between gap-3 px-5 py-4 border-b border-gray-6/60 bg-gray-2/40">
          <div>
            <div class="text-xs font-semibold text-gray-11 uppercase tracking-wider">
              {translate("skills.remote_title")}
            </div>
            <div class="text-sm text-gray-10 mt-2">{translate("skills.remote_description")}</div>
          </div>
          <Button
            variant="ghost"
            onClick={() => props.refreshRemoteSkills({ force: true })}
            disabled={!props.canBrowseRemoteSkills || props.remoteSkillsLoading}
          >
            {translate("skills.refresh")}
          </Button>
        </div>

        <div class="px-5 py-4 border-b border-gray-6/60 space-y-3">
          <div class="flex flex-col md:flex-row gap-3">
            <div class="flex-1">
              <TextInput
                label={translate("skills.remote_source_label")}
                placeholder={translate("skills.source_placeholder")}
                value={remoteSourceInput()}
                onInput={(event) => setRemoteSourceInput(event.currentTarget.value)}
                disabled={!props.canBrowseRemoteSkills || remoteSourceBusy()}
              />
            </div>
            <Button
              variant="secondary"
              class="md:mt-6"
              onClick={addRemoteSource}
              disabled={!props.canBrowseRemoteSkills || remoteSourceBusy() || !remoteSourceInput().trim()}
            >
              {translate("skills.remote_add_source")}
            </Button>
          </div>
          <Show when={props.remoteAccessHint}>
            <div class="text-xs text-gray-10">{props.remoteAccessHint}</div>
          </Show>
          <Show when={props.remoteSkillsStatus}>
            <div class="text-xs text-gray-10">{props.remoteSkillsStatus}</div>
          </Show>
        </div>

        <Show
          when={props.remoteSkillSources.length}
          fallback={
            <div class="px-5 py-6 text-sm text-gray-10">{translate("skills.remote_no_sources")}</div>
          }
        >
          <div class="divide-y divide-gray-6/60">
            <For each={props.remoteSkillSources}>
              {(source) => {
                const sourceSkills = () => remoteSkillsBySource().get(source.id) ?? [];
                const sourceRef = () => source.ref ?? source.resolvedRef;
                const sourceTitle = () =>
                  source.repo
                    ? `${source.repo}${sourceRef() ? `#${sourceRef()}` : ""}`
                    : source.input;

                return (
                  <div class="px-5 py-4 space-y-3">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <div class="space-y-1">
                        <div class="text-xs font-semibold text-gray-11">{sourceTitle()}</div>
                        <Show when={source.pathPrefix}>
                          <div class="text-xs text-gray-7 font-mono">{source.pathPrefix}</div>
                        </Show>
                      </div>
                      <div class="flex items-center gap-2">
                        <Show when={source.status === "loading"}>
                          <div class="text-xs text-gray-10">{translate("skills.remote_loading")}</div>
                        </Show>
                        <Button
                          variant="ghost"
                          class="text-xs"
                          onClick={() => props.removeRemoteSkillSource(source.id)}
                          disabled={props.remoteSkillsLoading}
                        >
                          {translate("skills.remote_remove")}
                        </Button>
                      </div>
                    </div>
                    <Show when={source.errorMessage}>
                      <div class="text-xs text-rose-9">{source.errorMessage}</div>
                    </Show>
                    <Show
                      when={sourceSkills().length}
                      fallback={<div class="text-xs text-gray-10">{translate("skills.remote_no_skills")}</div>}
                    >
                      <div class="grid gap-3">
                        <For each={sourceSkills()}>
                          {(skill) => {
                            const installed = () => installedNames().has(skill.name);
                            const installState = () => props.remoteSkillInstallState[skill.id];
                            const installing = () => installState()?.status === "installing";
                            const installError = () => installState()?.message;

                            return (
                              <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 p-4 space-y-2">
                                <div class="flex items-start justify-between gap-3">
                                  <div class="space-y-1">
                                    <div class="text-sm font-medium text-gray-12 font-mono">{skill.name}</div>
                                    <Show when={skill.description}>
                                      <div class="text-xs text-gray-10">{skill.description}</div>
                                    </Show>
                                    <div class="text-[10px] text-gray-7 font-mono">{skill.path}</div>
                                  </div>
                                  <Button
                                    variant={installed() ? "outline" : "secondary"}
                                    class="text-xs"
                                    onClick={() => props.installRemoteSkill(skill)}
                                    disabled={
                                      props.busy ||
                                      installing() ||
                                      installed() ||
                                      !props.canInstallRemoteSkills
                                    }
                                  >
                                    {installing()
                                      ? translate("skills.remote_installing")
                                      : installed()
                                        ? translate("skills.installed_label")
                                        : translate("skills.install")}
                                  </Button>
                                </div>
                                <Show when={installError()}>
                                  <div class="text-[11px] text-rose-9">{installError()}</div>
                                </Show>
                              </div>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      <div>
        <div class="flex items-center justify-between mb-3">
          <div>
            <div class="text-sm font-semibold text-gray-12">{translate("skills.installed")}</div>
            <div class="text-xs text-gray-10 mt-1">{translate("skills.installed_description")}</div>
          </div>
          <div class="text-xs text-gray-10">{props.skills.length}</div>
        </div>

        <Show
          when={props.skills.length}
          fallback={
            <div class="rounded-2xl border border-gray-6/60 bg-gray-1/40 px-5 py-6 text-sm text-zinc-500">
              {translate("skills.no_skills")}
            </div>
          }
        >
          <div class="rounded-2xl border border-gray-6/60 bg-gray-1/40 divide-y divide-gray-6/60">
            <For each={props.skills}>
              {(s) => (
                <div class="px-5 py-4">
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <div class="space-y-2">
                      <div class="flex items-center gap-2">
                        <Package size={16} class="text-gray-11" />
                        <div class="font-medium text-gray-12">{s.name}</div>
                      </div>
                      <Show when={s.description}>
                        <div class="text-sm text-gray-10">{s.description}</div>
                      </Show>
                      <div class="text-xs text-gray-7 font-mono">{s.path}</div>
                    </div>
                    <Button
                      variant="danger"
                      class="!px-3 !py-2 text-xs"
                      onClick={() => setUninstallTarget(s)}
                      disabled={props.busy || !props.canUseDesktopTools}
                      title={translate("skills.uninstall")}
                    >
                      {translate("skills.uninstall")}
                    </Button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <Show when={uninstallOpen()}>
        <div class="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="bg-gray-2 border border-gray-6/70 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden">
            <div class="p-6">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h3 class="text-lg font-semibold text-gray-12">{translate("skills.uninstall_title")}</h3>
                  <p class="text-sm text-gray-11 mt-1">
                    {translate("skills.uninstall_warning").replace("{name}", uninstallTarget()?.name ?? "")}
                  </p>
                </div>
              </div>

              <div class="mt-4 rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-xs text-gray-11 font-mono break-all">
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
