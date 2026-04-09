import { For, Show } from "solid-js";

import { FolderCode, Rocket, Users } from "lucide-solid";

import WorkspaceOptionCard from "./option-card";
import {
  errorBannerClass,
  iconTileClass,
  inputClass,
  pillPrimaryClass,
  pillSecondaryClass,
  successBannerClass,
  surfaceCardClass,
  tagClass,
  warningBannerClass,
} from "./modal-styles";
import type { ShareView } from "./types";

type TemplateContentSummary = {
  skillNames: string[];
  commandNames: string[];
  configFiles: string[];
};

type IncludedSection = {
  title: string;
  detail: string;
  accentClass: string;
  count: number;
  items: string[];
};

const IncludedTemplateItems = (props: { sections: IncludedSection[] }) => {
  const nonEmpty = () => props.sections.filter((s) => s.items.length > 0);

  return (
    <Show when={nonEmpty().length > 0}>
      <div class="mt-5 border-t border-dls-border pt-5">
        <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-dls-secondary">
          Included in this template
        </div>

        <div class="mt-3 space-y-3">
          <For each={nonEmpty()}>
            {(section) => (
              <div class="rounded-2xl bg-dls-hover/60 px-4 py-3.5">
                <div class="flex items-center gap-2.5">
                  <div
                    class={`h-2.5 w-2.5 shrink-0 rounded-full bg-gradient-to-br ${section.accentClass}`}
                  />
                  <span class="text-[11px] font-semibold uppercase tracking-[0.16em] text-dls-secondary">
                    {section.title}
                  </span>
                  <span class="text-[11px] text-dls-secondary">
                    {section.count}
                  </span>
                </div>

                <div class="mt-2.5 flex flex-wrap gap-1.5">
                  <For each={section.items}>
                    {(name) => (
                      <span class="rounded-md bg-dls-surface px-2 py-1 text-[12px] text-dls-text shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                        {name}
                      </span>
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
};

export default function ShareWorkspaceTemplatePanel(props: {
  view: ShareView;
  setView: (next: ShareView) => void;
  copiedKey: string | null;
  onCopy: (value: string, key: string) => void;
  workspaceName: string;
  teamTemplateName: string;
  onTeamTemplateNameInput: (value: string) => void;
  onShareWorkspaceProfile?: () => void;
  shareWorkspaceProfileBusy?: boolean;
  shareWorkspaceProfileUrl?: string | null;
  shareWorkspaceProfileError?: string | null;
  shareWorkspaceProfileDisabledReason?: string | null;
  shareWorkspaceProfileSensitiveWarnings?: Array<{ id: string; label: string; detail: string }> | null;
  shareWorkspaceProfileSensitiveMode?: "include" | "exclude" | null;
  onShareWorkspaceProfileSensitiveModeChange?: (mode: "include" | "exclude") => void;
  onShareWorkspaceProfileToTeam?: (name: string) => void | Promise<void>;
  shareWorkspaceProfileToTeamBusy?: boolean;
  shareWorkspaceProfileToTeamError?: string | null;
  shareWorkspaceProfileToTeamSuccess?: string | null;
  shareWorkspaceProfileToTeamDisabledReason?: string | null;
  shareWorkspaceProfileToTeamOrgName?: string | null;
  shareWorkspaceProfileToTeamNeedsSignIn?: boolean;
  onShareWorkspaceProfileToTeamSignIn?: () => void | Promise<void>;
  templateContentSummary?: TemplateContentSummary | null;
}) {
  const sensitiveWarnings = () => props.shareWorkspaceProfileSensitiveWarnings ?? [];
  const exportDecisionMissing = () => sensitiveWarnings().length > 0 && !props.shareWorkspaceProfileSensitiveMode;
  const sensitiveDecisionDisabledReason = () =>
    exportDecisionMissing()
      ? "Choose how to handle sensitive config before continuing."
      : (props.shareWorkspaceProfileDisabledReason ?? null);
  const teamDecisionDisabledReason = () =>
    exportDecisionMissing()
      ? "Choose how to handle sensitive config before continuing."
      : (props.shareWorkspaceProfileToTeamDisabledReason ?? null);

  const renderGeneratedLink = (
    value: string | null | undefined,
    copyKey: string,
    regenerate: (() => void) | undefined,
    busy: boolean | undefined,
    createLabel: string,
    regenerateLabel: string,
    createAction: (() => void) | undefined,
    disabledReason: string | null | undefined,
  ) => (
    <Show
      when={value?.trim()}
      fallback={
        <button
          type="button"
          onClick={() => createAction?.()}
          disabled={Boolean(disabledReason) || !createAction || busy}
          class={`${pillPrimaryClass} mt-4 w-full`}
        >
          {busy ? "Publishing…" : createLabel}
        </button>
      }
    >
      <div class="animate-in fade-in zoom-in-95 duration-200">
        <div class="flex items-center gap-2">
          <input type="text" readonly value={value!} class={`${inputClass} flex-1 font-mono text-[12px]`} />
          <button type="button" onClick={() => props.onCopy(value ?? "", copyKey)} class={pillSecondaryClass} title="Copy link">
            {props.copiedKey === copyKey ? "Copied" : "Copy"}
          </button>
        </div>
        <button type="button" onClick={() => regenerate?.()} disabled={busy} class={`${pillSecondaryClass} mt-3 w-full`}>
          {busy ? "Publishing…" : regenerateLabel}
        </button>
      </div>
    </Show>
  );

  const SensitiveExportWarningCard = () => (
    <Show when={sensitiveWarnings().length > 0}>
      <div class={warningBannerClass}>
        <div class="text-[13px] font-medium text-dls-text">This export includes sensitive workspace config.</div>
        <div class="mt-1 text-[12px] leading-relaxed text-dls-secondary">
          OpenWork found config that can expose secrets, remote endpoints, or persistence points. Choose how to handle it before publishing.
        </div>
        <div class="mt-3 space-y-2 text-[12px] leading-relaxed text-dls-secondary">
          <For each={sensitiveWarnings()}>
            {(warning) => (
              <div>
                <span class="font-medium text-dls-text">{warning.label}:</span> {warning.detail}
              </div>
            )}
          </For>
        </div>
        <div class="mt-4 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => props.onShareWorkspaceProfileSensitiveModeChange?.("exclude")}
            class={`${pillSecondaryClass} ${props.shareWorkspaceProfileSensitiveMode === "exclude" ? "border-[var(--dls-accent)] text-[var(--dls-accent)]" : ""}`}
            aria-pressed={props.shareWorkspaceProfileSensitiveMode === "exclude"}
          >
            Exclude sensitive config
          </button>
          <button
            type="button"
            onClick={() => props.onShareWorkspaceProfileSensitiveModeChange?.("include")}
            class={`${pillSecondaryClass} ${props.shareWorkspaceProfileSensitiveMode === "include" ? "border-[var(--dls-accent)] text-[var(--dls-accent)]" : ""}`}
            aria-pressed={props.shareWorkspaceProfileSensitiveMode === "include"}
          >
            Include everything
          </button>
        </div>
      </div>
    </Show>
  );

  const templateIncludedSections = (): IncludedSection[] => {
    const summary = props.templateContentSummary;
    if (!summary) return [];

    const sections: IncludedSection[] = [];

    if (summary.skillNames.length > 0) {
      sections.push({
        title: "Skills",
        detail: "Custom workspace skills bundled with this template.",
        accentClass: "from-[#6e87ff] via-[#4f6dff] to-[#1b29ff]",
        count: summary.skillNames.length,
        items: summary.skillNames,
      });
    }

    if (summary.commandNames.length > 0) {
      sections.push({
        title: "Commands",
        detail: "Reusable slash commands.",
        accentClass: "from-[#67d9d1] via-[#3fcfc3] to-[#0f9f9a]",
        count: summary.commandNames.length,
        items: summary.commandNames,
      });
    }

    if (summary.configFiles.length > 0) {
      sections.push({
        title: "Config",
        detail: "Workspace config and portable files.",
        accentClass: "from-[#ffb570] via-[#ff9e43] to-[#f97316]",
        count: summary.configFiles.length,
        items: summary.configFiles,
      });
    }

    return sections;
  };

  const needsSignIn = props.shareWorkspaceProfileToTeamNeedsSignIn === true;

  return (
    <>
      <Show when={props.view === "template"}>
        <div class="space-y-4 pt-2 animate-in fade-in slide-in-from-right-4 duration-300">
          <div class="text-[14px] leading-relaxed text-dls-secondary">
            Share a reusable setup without granting live access to this running workspace.
          </div>
          <div class="space-y-4">
            <WorkspaceOptionCard
              title="Share with team"
              description="Save this workspace template to your active OpenWork Cloud organization."
              icon={Users}
              onClick={() => props.setView("template-team")}
            />
            <WorkspaceOptionCard
              title="Public template"
              description="Create a share link anyone can use to start from this template."
              icon={Rocket}
              onClick={() => props.setView("template-public")}
            />
          </div>
        </div>
      </Show>

      <Show when={props.view === "template-public"}>
        <div class="space-y-5 pt-2 animate-in fade-in slide-in-from-right-4 duration-300">
          <div class="text-[14px] leading-relaxed text-dls-secondary">Share this workspace as a public template link.</div>

          <div class={surfaceCardClass}>
            <div class="mb-4 flex items-start gap-3">
              <div class={iconTileClass}>
                <FolderCode size={18} />
              </div>
              <div class="flex-1">
                <h3 class="text-[18px] font-semibold tracking-[-0.3px] text-dls-text">Workspace template</h3>
                <p class="mt-1 text-[14px] leading-relaxed text-dls-secondary">Share the core setup and workspace defaults.</p>
              </div>
            </div>

            <Show when={props.shareWorkspaceProfileError?.trim()}>
              <div class={`mb-3 ${errorBannerClass}`}>{props.shareWorkspaceProfileError}</div>
            </Show>
            <Show when={sensitiveDecisionDisabledReason()?.trim()}>
              <div class="mb-3 text-[12px] text-dls-secondary">{sensitiveDecisionDisabledReason()}</div>
            </Show>

            <SensitiveExportWarningCard />

            {renderGeneratedLink(
              props.shareWorkspaceProfileUrl,
              "share-workspace-profile",
              props.onShareWorkspaceProfile,
              props.shareWorkspaceProfileBusy,
              "Create template link",
              "Regenerate link",
              props.onShareWorkspaceProfile,
              sensitiveDecisionDisabledReason(),
            )}

            <IncludedTemplateItems sections={templateIncludedSections()} />
          </div>
        </div>
      </Show>

      <Show when={props.view === "template-team"}>
        <div class="space-y-5 pt-2 animate-in fade-in slide-in-from-right-4 duration-300">
          <div class="text-[14px] leading-relaxed text-dls-secondary">
            Save this template to your active OpenWork Cloud organization so teammates can open it later from Cloud settings.
          </div>

          <div class={surfaceCardClass}>
            <div class="flex flex-wrap items-center gap-2">
              <span class={tagClass}>{props.shareWorkspaceProfileToTeamOrgName?.trim() || "Active Cloud org"}</span>
            </div>

            <div class="mt-4">
              <label class="mb-1.5 block text-[13px] font-medium text-dls-text">Template name</label>
              <input
                type="text"
                value={props.teamTemplateName}
                onInput={(event) => props.onTeamTemplateNameInput(event.currentTarget.value)}
                class={inputClass}
                placeholder={`${props.workspaceName.trim() || "Workspace"} template`}
              />
            </div>

            <Show when={props.shareWorkspaceProfileToTeamError?.trim()}>
              <div class={`mt-4 ${errorBannerClass}`}>{props.shareWorkspaceProfileToTeamError}</div>
            </Show>

            <Show when={props.shareWorkspaceProfileToTeamSuccess?.trim()}>
              <div class={`mt-4 ${successBannerClass}`}>{props.shareWorkspaceProfileToTeamSuccess}</div>
            </Show>

            <Show when={teamDecisionDisabledReason()?.trim() && !needsSignIn}>
              <div class="mt-4 text-[12px] text-dls-secondary">{teamDecisionDisabledReason()}</div>
            </Show>

            <SensitiveExportWarningCard />

            <button
              type="button"
              onClick={() => {
                if (needsSignIn) {
                  void props.onShareWorkspaceProfileToTeamSignIn?.();
                  return;
                }
                void props.onShareWorkspaceProfileToTeam?.(props.teamTemplateName);
              }}
              disabled={
                needsSignIn
                  ? !props.onShareWorkspaceProfileToTeamSignIn
                  : Boolean(teamDecisionDisabledReason()) ||
                    !props.onShareWorkspaceProfileToTeam ||
                    props.shareWorkspaceProfileToTeamBusy ||
                    !props.teamTemplateName.trim()
              }
              class={`${pillPrimaryClass} mt-4 w-full`}
            >
              {needsSignIn
                ? "Sign in to share with team"
                : props.shareWorkspaceProfileToTeamBusy
                  ? "Saving…"
                  : "Save to team"}
            </button>

            <Show when={needsSignIn}>
              <div class="mt-3 text-[12px] text-dls-secondary">OpenWork Cloud opens in your browser and returns here after sign-in.</div>
            </Show>

            <IncludedTemplateItems sections={templateIncludedSections()} />
          </div>
        </div>
      </Show>
    </>
  );
}
