import { For, Show } from "solid-js";

import type { SkillCard } from "../types";
import { isTauriRuntime, isWindowsPlatform } from "../utils";

import Button from "../components/button";
import { FolderOpen, GitBranch, MessageSquare, Package } from "lucide-solid";
import { currentLocale, t } from "../../i18n";

export type SkillsViewProps = {
  busy: boolean;
  mode: "host" | "client" | null;
  refreshSkills: (options?: { force?: boolean }) => void;
  skills: SkillCard[];
  skillsStatus: string | null;
  skillRepoSource: string;
  setSkillRepoSource: (value: string) => void;
  installSkillCreator: () => void;
  importSkillsFromRepo: () => void;
  revealSkillsFolder: () => void;
  createSessionAndOpen: () => void;
};

export default function SkillsView(props: SkillsViewProps) {
  // Translation helper that uses current language from i18n
  const translate = (key: string) => t(key, currentLocale());
  const canManageSkills = () => props.mode === "host" && isTauriRuntime();
  const revealLabel = () =>
    isWindowsPlatform() ? translate("skills.reveal_button_windows") : translate("skills.reveal_button");

  return (
    <section class="space-y-6">
      <div class="flex items-start justify-between">
        <div>
          <h3 class="text-sm font-medium text-gray-11 uppercase tracking-wider">
            {translate("skills.title")}
          </h3>
          <p class="text-xs text-gray-10 mt-1">{translate("skills.subtitle")}</p>
        </div>
        <Button
          variant="secondary"
          onClick={() => props.refreshSkills({ force: true })}
          disabled={props.busy}
        >
          {translate("skills.refresh")}
        </Button>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div class="flex items-start justify-between gap-4">
          <div>
            <div class="text-sm font-medium text-gray-12">{translate("skills.add_title")}</div>
            <div class="text-xs text-gray-10 mt-1">{translate("skills.add_description")}</div>
          </div>
          <Show when={props.mode !== "host"}>
            <div class="text-xs text-gray-10">{translate("skills.host_mode_only")}</div>
          </Show>
        </div>

        <div class="rounded-xl border border-gray-6/70 bg-gray-1/40 p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div class="text-sm font-medium text-gray-12">{translate("skills.skill_creator_title")}</div>
            <div class="text-xs text-gray-10 mt-1">{translate("skills.skill_creator_description")}</div>
          </div>
          <Button
            variant="secondary"
            onClick={props.installSkillCreator}
            disabled={props.busy || !canManageSkills()}
          >
            <Package size={16} />
            {translate("skills.install_skill_creator")}
          </Button>
        </div>

        <div class="rounded-xl border border-gray-6/70 bg-gray-1/40 p-4 space-y-3">
          <div>
            <div class="text-sm font-medium text-gray-12">{translate("skills.git_title")}</div>
            <div class="text-xs text-gray-10 mt-1">{translate("skills.git_description")}</div>
          </div>
          <div class="flex flex-col md:flex-row gap-2">
            <input
              class="w-full bg-zinc-900/50 border border-gray-6 rounded-xl px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600 focus:border-zinc-600 transition-all"
              placeholder={translate("skills.git_placeholder")}
              value={props.skillRepoSource}
              onInput={(e) => props.setSkillRepoSource(e.currentTarget.value)}
            />
            <Button
              onClick={props.importSkillsFromRepo}
              disabled={props.busy || !canManageSkills()}
              class="md:w-auto"
            >
              <GitBranch size={16} />
              {translate("skills.git_import")}
            </Button>
          </div>
          <div class="text-xs text-gray-10">{translate("skills.git_hint")}</div>
        </div>

        <div class="flex items-center justify-between gap-4 border-t border-zinc-800/60 pt-3">
          <div>
            <div class="text-sm font-medium text-gray-12">{translate("skills.reveal_title")}</div>
            <div class="text-xs text-gray-10 mt-1">{translate("skills.reveal_description")}</div>
          </div>
          <Button
            variant="secondary"
            onClick={props.revealSkillsFolder}
            disabled={props.busy || !canManageSkills()}
          >
            <FolderOpen size={16} />
            {revealLabel()}
          </Button>
        </div>

        <Show when={props.skillsStatus}>
          <div class="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-xs text-gray-11 whitespace-pre-wrap break-words">
            {props.skillsStatus}
          </div>
        </Show>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div class="flex items-center justify-between gap-4">
          <div>
            <div class="text-sm font-medium text-gray-12">{translate("skills.use_title")}</div>
            <div class="text-xs text-gray-10 mt-1">{translate("skills.use_description")}</div>
          </div>
          <Button variant="secondary" onClick={props.createSessionAndOpen} disabled={props.busy}>
            <MessageSquare size={16} />
            {translate("skills.use_button")}
          </Button>
        </div>
      </div>

      <div>
        <div class="flex items-center justify-between mb-3">
          <div class="text-sm font-medium text-gray-12">{translate("skills.installed")}</div>
          <div class="text-xs text-gray-10">{props.skills.length}</div>
        </div>

        <Show
          when={props.skills.length}
          fallback={
            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-6 text-sm text-zinc-500">
              {translate("skills.no_skills")}
            </div>
          }
        >
          <div class="grid gap-3">
            <For each={props.skills}>
              {(s) => (
                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5">
                  <div class="flex items-center gap-2">
                    <Package size={16} class="text-gray-11" />
                    <div class="font-medium text-gray-12">{s.name}</div>
                  </div>
                  <Show when={s.description}>
                    <div class="mt-1 text-sm text-gray-10">{s.description}</div>
                  </Show>
                  <div class="mt-2 text-xs text-gray-7 font-mono">{s.path}</div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </section>
  );
}
