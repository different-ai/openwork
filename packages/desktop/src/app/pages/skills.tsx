import { For, Show, createMemo, createSignal } from "solid-js";

import type { SkillCard } from "../types";

import Button from "../components/button";
import { FolderOpen, Package, Upload } from "lucide-solid";
import { currentLocale, t } from "../../i18n";

export type SkillsViewProps = {
  busy: boolean;
  mode: "host" | "client" | null;
  refreshSkills: (options?: { force?: boolean }) => void;
  skills: SkillCard[];
  skillsStatus: string | null;
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
          <Show when={props.mode !== "host"}>
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
              disabled={props.busy || skillCreatorInstalled()}
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
            <Button variant="secondary" onClick={props.importLocalSkill} disabled={props.busy}>
              <Upload size={16} />
              {translate("skills.import")}
            </Button>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div>
              <div class="text-sm font-medium text-gray-12">{translate("skills.reveal_folder")}</div>
              <div class="text-xs text-gray-10 mt-1">{translate("skills.reveal_folder_hint")}</div>
            </div>
            <Button variant="secondary" onClick={props.revealSkillsFolder} disabled={props.busy}>
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
                      disabled={props.busy}
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
