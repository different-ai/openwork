import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  FileCode2,
  FolderCode,
  MessageSquare,
  MonitorUp,
  Rocket,
  Settings2,
  Users,
  X,
} from "lucide-solid";

type ShareField = {
  label: string;
  value: string;
  secret?: boolean;
  placeholder?: string;
  hint?: string;
};

type ShareView = "chooser" | "template" | "template-public" | "template-team" | "access";

const isInviteField = (label: string) => /invite link/i.test(label);
const isCollaboratorField = (label: string) => /collaborator token/i.test(label);
const isPasswordField = (label: string) => /owner token|connected token|access token|password/i.test(label);
const isWorkerUrlField = (label: string) => /worker url/i.test(label);

const displayFieldLabel = (field: ShareField) => {
  if (isPasswordField(field.label)) return "Password";
  if (isWorkerUrlField(field.label)) return "Worker URL";
  return field.label;
};

export default function ShareWorkspaceModal(props: {
  open: boolean;
  onClose: () => void;
  title?: string;
  workspaceName: string;
  workspaceDetail?: string | null;
  fields: ShareField[];
  remoteAccess?: {
    enabled: boolean;
    busy: boolean;
    error?: string | null;
    onSave: (enabled: boolean) => void | Promise<void>;
  };
  note?: string | null;
  onShareWorkspaceProfile?: () => void;
  shareWorkspaceProfileBusy?: boolean;
  shareWorkspaceProfileUrl?: string | null;
  shareWorkspaceProfileError?: string | null;
  shareWorkspaceProfileDisabledReason?: string | null;
  onShareWorkspaceProfileToTeam?: (name: string) => void | Promise<void>;
  shareWorkspaceProfileToTeamBusy?: boolean;
  shareWorkspaceProfileToTeamError?: string | null;
  shareWorkspaceProfileToTeamSuccess?: string | null;
  shareWorkspaceProfileToTeamDisabledReason?: string | null;
  shareWorkspaceProfileToTeamOrgName?: string | null;
  shareWorkspaceProfileToTeamNeedsSignIn?: boolean;
  onShareWorkspaceProfileToTeamSignIn?: () => void | Promise<void>;
  onShareSkillsSet?: () => void;
  shareSkillsSetBusy?: boolean;
  shareSkillsSetUrl?: string | null;
  shareSkillsSetError?: string | null;
  shareSkillsSetDisabledReason?: string | null;
  onExportConfig?: () => void;
  exportDisabledReason?: string | null;
  onOpenBots?: () => void;
}) {
  const [activeView, setActiveView] = createSignal<ShareView>("chooser");
  const [revealedByIndex, setRevealedByIndex] = createSignal<Record<number, boolean>>({});
  const [copiedKey, setCopiedKey] = createSignal<string | null>(null);
  const [collaboratorExpanded, setCollaboratorExpanded] = createSignal(false);
  const [remoteAccessEnabled, setRemoteAccessEnabled] = createSignal(false);
  const [teamTemplateName, setTeamTemplateName] = createSignal("");

  const title = createMemo(() => props.title ?? "Share workspace");
  const workspaceBadge = createMemo(() => {
    const raw = props.workspaceName?.trim() || "Workspace";
    const parts = raw.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || raw;
  });
  const note = createMemo(() => props.note?.trim() ?? "");
  const teamShareNeedsSignIn = createMemo(
    () => props.shareWorkspaceProfileToTeamNeedsSignIn === true,
  );
  const accessFields = createMemo(() => props.fields.filter((field) => !isInviteField(field.label)));
  const collaboratorField = createMemo(() => accessFields().find((field) => isCollaboratorField(field.label)) ?? null);
  const primaryAccessFields = createMemo(() =>
    accessFields().filter((field) => !isCollaboratorField(field.label)),
  );
  const templateIncludedItems = createMemo(() => [
    {
      title: "Workspace settings",
      detail: "The shared workspace profile and default behavior.",
      icon: Settings2,
    },
    {
      title: "Included skills",
      detail: "Custom skills saved in this workspace.",
      icon: Rocket,
    },
    {
      title: "Commands and config",
      detail: "Reusable commands, OpenWork/OpenCode config, and portable .opencode files.",
      icon: FileCode2,
    },
  ]);

  const primaryButtonClass = "ow-button-primary px-5 py-3";
  const secondaryButtonClass = "ow-button-secondary px-5 py-3";
  const softCardClass = "ow-soft-card rounded-[1.5rem] p-5";
  const quietCardClass = "ow-soft-card-quiet rounded-[1.5rem] p-4";

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setActiveView("chooser");
        setRevealedByIndex({});
        setCopiedKey(null);
        setCollaboratorExpanded(false);
        setRemoteAccessEnabled(props.remoteAccess?.enabled === true);
        setTeamTemplateName(`${props.workspaceName.trim() || "Workspace"} template`);
      },
    ),
  );

  createEffect(
    on(
      () => props.remoteAccess?.enabled,
      (enabled, previous) => {
        if (!props.open) return;
        if (enabled === previous) return;
        setRemoteAccessEnabled(enabled === true);
      },
    ),
  );

  createEffect(() => {
    if (!props.open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const view = activeView();
      if (view === "chooser") {
        props.onClose();
        return;
      }
      if (view === "template-public" || view === "template-team") {
        setActiveView("template");
        return;
      }
      setActiveView("chooser");
    };
    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  const goBack = () => {
    const view = activeView();
    if (view === "template-public" || view === "template-team") {
      setActiveView("template");
      return;
    }
    setActiveView("chooser");
  };

  const handleCopy = async (value: string, key: string) => {
    const text = value?.trim() ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 2000);
    } catch {
      // ignore clipboard failures
    }
  };

  const renderOptionCard = (
    titleText: string,
    body: string,
    icon: typeof Rocket,
    onClick: () => void,
    tone: "primary" | "secondary" = "primary",
  ) => {
    const Icon = icon;
    const isSecondary = tone === "secondary";
    return (
      <button
        type="button"
        onClick={onClick}
        class={
          isSecondary
            ? "ow-soft-card-quiet group w-full rounded-[1.5rem] p-5 text-left transition-colors hover:bg-[#f1f5f9]"
            : "ow-soft-card group w-full rounded-[1.5rem] p-5 text-left transition-colors hover:bg-gray-50/50"
        }
      >
        <div class="flex items-start justify-between gap-4">
          <div class="flex gap-4">
            <div
              class={
                isSecondary
                  ? "ow-icon-tile-muted mt-0.5 h-10 w-10 shrink-0"
                  : "ow-icon-tile mt-0.5 h-10 w-10 shrink-0"
              }
            >
              <Icon size={18} />
            </div>
            <div class="flex-1">
              <h3 class={isSecondary ? "text-[15px] font-medium tracking-tight text-gray-800" : "text-[15px] font-medium tracking-tight text-[#011627]"}>
                {titleText}
              </h3>
              <p class="mt-1 max-w-[38ch] text-[13px] leading-relaxed text-gray-500">{body}</p>
            </div>
          </div>
        </div>
      </button>
    );
  };

  const renderCredentialField = (field: ShareField, index: () => number, keyPrefix: string) => {
    const key = () => `${keyPrefix}:${field.label}:${index()}`;
    const isSecret = () => Boolean(field.secret);
    const revealed = () => Boolean(revealedByIndex()[index()]);

    return (
      <div>
        <label class="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-gray-500">
          {displayFieldLabel(field)}
        </label>
        <div class="relative flex items-center">
          <input
            type={isSecret() && !revealed() ? "password" : "text"}
            readonly
            value={field.value || field.placeholder || ""}
            class="ow-input py-3 pl-3 pr-20 text-[12px] font-mono text-dls-text"
          />
          <div class="absolute right-1 flex items-center gap-0.5">
            <Show when={isSecret()}>
              <button
                onClick={() =>
                  setRevealedByIndex((prev) => ({
                    ...prev,
                    [index()]: !prev[index()],
                  }))
                }
                disabled={!field.value}
                class="rounded-full p-1.5 text-gray-500 transition-colors hover:bg-white hover:text-gray-700 disabled:opacity-50"
                title={revealed() ? "Hide password" : "Reveal password"}
              >
                <Show when={revealed()} fallback={<Eye size={14} />}>
                  <EyeOff size={14} />
                </Show>
              </button>
            </Show>
            <button
              onClick={() => handleCopy(field.value, key())}
              disabled={!field.value}
              class="rounded-full p-1.5 text-gray-500 transition-colors hover:bg-white hover:text-gray-700 disabled:opacity-50"
              title="Copy"
            >
              <Show when={copiedKey() === key()} fallback={<Copy size={14} />}>
                <Check size={14} class="text-emerald-600" />
              </Show>
            </button>
          </div>
        </div>
        <Show when={field.hint && field.hint.trim()}>
          <p class="mt-1.5 text-[11px] text-gray-500">{field.hint}</p>
        </Show>
      </div>
    );
  };

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
          onClick={() => createAction?.()}
          disabled={Boolean(disabledReason) || !createAction || busy}
          class={`${primaryButtonClass} mt-4 w-full`}
        >
          {busy ? "Publishing..." : createLabel}
        </button>
      }
    >
      <div class="animate-in fade-in zoom-in-95 duration-200">
        <div class="flex items-center gap-2">
          <input
            type="text"
            readonly
            value={value!}
            class="ow-input flex-1 px-3 py-3 text-[12px] font-mono text-gray-700"
          />
          <button
            onClick={() => handleCopy(value ?? "", copyKey)}
            class="rounded-full p-2 text-gray-500 transition-colors hover:bg-white hover:text-gray-700"
            title="Copy link"
          >
            <Show when={copiedKey() === copyKey} fallback={<Copy size={14} />}>
              <Check size={14} class="text-emerald-600" />
            </Show>
          </button>
        </div>
        <button
          onClick={() => regenerate?.()}
          disabled={busy}
          class={`${secondaryButtonClass} mt-3 w-full`}
        >
          {busy ? "Publishing..." : regenerateLabel}
        </button>
      </div>
    </Show>
  );

  const renderTemplateIncludedList = () => (
    <div class="mt-5 border-t border-[#eceef1] pt-5">
      <div class="mb-3 text-[11px] font-bold uppercase tracking-[0.18em] text-gray-500">
        Included in this template
      </div>
      <div class="space-y-3">
        <For each={templateIncludedItems()}>
          {(item) => {
            const Icon = item.icon;
            return (
              <div class="flex items-start gap-3">
                <div class="ow-icon-tile-muted h-8 w-8 shrink-0 rounded-lg">
                  <Icon size={15} />
                </div>
                <div class="min-w-0">
                  <div class="text-[13px] font-medium text-[#011627]">{item.title}</div>
                  <div class="mt-0.5 text-[12px] leading-relaxed text-gray-500">{item.detail}</div>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/35 px-3 pt-[10vh] font-sans animate-in fade-in duration-200 md:px-6">
        <div
          class="ow-soft-shell relative flex max-h-[78vh] w-full max-w-[640px] flex-col overflow-hidden rounded-[2rem] shadow-[0_24px_72px_-30px_rgba(15,23,42,0.28)] animate-in fade-in zoom-in-95 duration-300"
          role="dialog"
          aria-modal="true"
        >
          <div class="relative shrink-0 px-6 pb-4 pt-5 md:px-7 md:pt-6">
            <button
              onClick={props.onClose}
              class="absolute right-5 top-5 rounded-full p-2 text-gray-500 transition-colors hover:bg-white hover:text-gray-700"
              aria-label="Close"
              title="Close"
            >
              <X size={16} />
            </button>

            <Show when={activeView() !== "chooser"}>
              <button
                onClick={goBack}
                class="absolute left-5 top-5 rounded-full p-2 text-gray-500 transition-colors hover:bg-white hover:text-gray-700"
                aria-label="Back"
                title="Back to share options"
              >
                <ArrowLeft size={16} />
              </button>
            </Show>

            <div class="flex items-center gap-2" classList={{ "ml-8": activeView() !== "chooser" }}>
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <h2 class="truncate text-[20px] font-semibold tracking-tight text-[#011627]">
                    <Show when={activeView() === "chooser"}>{title()}</Show>
                    <Show when={activeView() === "template"}>Share a template</Show>
                    <Show when={activeView() === "template-public"}>Public template</Show>
                    <Show when={activeView() === "template-team"}>Share with team</Show>
                    <Show when={activeView() === "access"}>Access workspace remotely</Show>
                  </h2>
                  <Show when={activeView() === "chooser"}>
                    <span class="rounded-full bg-gray-100 px-3 py-1 text-[11px] font-medium text-gray-600">
                      {workspaceBadge()}
                    </span>
                  </Show>
                </div>
              </div>
            </div>
          </div>

          <div class="flex-1 overflow-y-auto px-6 pb-7 scrollbar-hide md:px-7">
            <Show when={activeView() === "chooser"}>
              <div class="space-y-4 pt-2 animate-in fade-in slide-in-from-bottom-3 duration-300">
                {renderOptionCard(
                  "Share a template",
                  "Package this setup so someone else can start from the same environment.",
                  Rocket,
                  () => setActiveView("template"),
                )}

                {renderOptionCard(
                  "Access workspace remotely",
                  "Reveal the live connection details needed to reach this running workspace from another machine.",
                  MonitorUp,
                  () => setActiveView("access"),
                )}
              </div>
            </Show>

            <Show when={activeView() === "template"}>
              <div class="space-y-4 pt-2 animate-in fade-in slide-in-from-right-4 duration-300">
                <div class="text-[14px] leading-relaxed text-gray-500">
                  Share a reusable setup without granting live access to this running workspace.
                </div>

                <div class="space-y-4">
                  {renderOptionCard(
                    "Share with team",
                    "Save this workspace template to your active OpenWork Cloud organization.",
                    Users,
                    () => setActiveView("template-team"),
                  )}

                  {renderOptionCard(
                    "Public template",
                    "Create a share link anyone can use to start from this template.",
                    Rocket,
                    () => setActiveView("template-public"),
                    "secondary",
                  )}
                </div>
              </div>
            </Show>

            <Show when={activeView() === "template-public"}>
              <div class="space-y-5 pt-2 animate-in fade-in slide-in-from-right-4 duration-300">
                <div class="text-[14px] leading-relaxed text-gray-500">
                  Share this workspace as a public template link.
                </div>

                <div class={softCardClass}>
                  <div class="mb-4 flex items-start justify-between gap-3">
                    <div class="flex items-center gap-3">
                      <div class="ow-icon-tile h-10 w-10 shrink-0 rounded-full">
                        <FolderCode size={18} />
                      </div>
                      <div class="flex-1">
                        <h3 class="text-[18px] font-medium tracking-tight text-[#011627]">Workspace template</h3>
                        <p class="mt-1 text-[14px] leading-relaxed text-gray-500">Share the core setup and workspace defaults.</p>
                      </div>
                    </div>
                  </div>

                  <Show when={props.shareWorkspaceProfileError?.trim()}>
                    <div class="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
                      {props.shareWorkspaceProfileError}
                    </div>
                  </Show>
                  <Show when={props.shareWorkspaceProfileDisabledReason?.trim()}>
                    <div class="mb-3 text-[12px] text-gray-500">{props.shareWorkspaceProfileDisabledReason}</div>
                  </Show>

                  {renderGeneratedLink(
                    props.shareWorkspaceProfileUrl,
                    "share-workspace-profile",
                    props.onShareWorkspaceProfile,
                    props.shareWorkspaceProfileBusy,
                    "Create template link",
                    "Regenerate link",
                    props.onShareWorkspaceProfile,
                    props.shareWorkspaceProfileDisabledReason,
                  )}

                  {renderTemplateIncludedList()}
                </div>
              </div>
            </Show>

            <Show when={activeView() === "template-team"}>
              <div class="space-y-5 pt-2 animate-in fade-in slide-in-from-right-4 duration-300">
                <div class="text-[14px] leading-relaxed text-gray-500">
                  Save this template to your active OpenWork Cloud organization so teammates can open it later from Cloud settings.
                </div>

                <div class={softCardClass}>
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="rounded-full border border-[#e5e7eb] bg-[#f8fafc] px-3 py-1 text-[11px] font-medium text-gray-600">
                      {props.shareWorkspaceProfileToTeamOrgName?.trim() || "Active Cloud org"}
                    </span>
                  </div>

                  <div class="mt-4">
                    <label class="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-gray-500">
                      Template name
                    </label>
                    <input
                      type="text"
                      value={teamTemplateName()}
                      onInput={(event) => setTeamTemplateName(event.currentTarget.value)}
                      class="ow-input px-3 py-3 text-[14px] text-dls-text"
                      placeholder={`${props.workspaceName.trim() || "Workspace"} template`}
                    />
                  </div>

                  <Show when={props.shareWorkspaceProfileToTeamError?.trim()}>
                    <div class="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
                      {props.shareWorkspaceProfileToTeamError}
                    </div>
                  </Show>

                  <Show when={props.shareWorkspaceProfileToTeamSuccess?.trim()}>
                    <div class="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-700">
                      {props.shareWorkspaceProfileToTeamSuccess}
                    </div>
                  </Show>

                  <Show when={props.shareWorkspaceProfileToTeamDisabledReason?.trim() && !teamShareNeedsSignIn()}>
                    <div class="mt-4 text-[12px] text-gray-500">{props.shareWorkspaceProfileToTeamDisabledReason}</div>
                  </Show>

                  <button
                    onClick={() => {
                      if (teamShareNeedsSignIn()) {
                        void props.onShareWorkspaceProfileToTeamSignIn?.();
                        return;
                      }
                      void props.onShareWorkspaceProfileToTeam?.(teamTemplateName());
                    }}
                    disabled={
                      teamShareNeedsSignIn()
                        ? !props.onShareWorkspaceProfileToTeamSignIn
                        : Boolean(props.shareWorkspaceProfileToTeamDisabledReason) ||
                          !props.onShareWorkspaceProfileToTeam ||
                          props.shareWorkspaceProfileToTeamBusy ||
                          !teamTemplateName().trim()
                    }
                    class={`${primaryButtonClass} mt-4 w-full`}
                  >
                    {teamShareNeedsSignIn()
                      ? "Sign in to share with team"
                      : props.shareWorkspaceProfileToTeamBusy
                        ? "Saving..."
                        : "Save to team"}
                  </button>

                  <Show when={teamShareNeedsSignIn()}>
                    <div class="mt-3 text-[11px] text-gray-500">
                      OpenWork Cloud opens in your browser and returns here after sign-in.
                    </div>
                  </Show>

                  {renderTemplateIncludedList()}
                </div>
              </div>
            </Show>

            <Show when={activeView() === "access"}>
              <div class="space-y-5 pt-2 animate-in fade-in slide-in-from-right-4 duration-300">
                <div class="flex items-start gap-2 rounded-[1.25rem] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900">
                  <span class="mt-0.5">⚠️</span>
                  <span class="leading-relaxed">
                    <Show
                      when={props.remoteAccess}
                      fallback={
                        "Share with trusted people only. These credentials grant live access to this workspace."
                      }
                    >
                      These credentials grant live access to this workspace. Sharing this workspace remotely may allow anyone with access to your network to control your worker.
                    </Show>
                  </span>
                </div>

                <Show when={props.remoteAccess}>
                  {(remoteAccess) => {
                    const hasPendingChange = () =>
                      remoteAccessEnabled() !== remoteAccess().enabled;

                    return (
                      <div class={softCardClass}>
                        <div class="flex items-start justify-between gap-3">
                          <div>
                            <h3 class="text-[18px] font-medium tracking-tight text-[#011627]">Remote access</h3>
                            <p class="mt-1 text-[14px] leading-relaxed text-gray-500">
                              Off by default. Turn this on only when you want this worker reachable from another machine.
                            </p>
                          </div>
                          <label class="relative inline-flex shrink-0 cursor-pointer items-center">
                            <input
                              type="checkbox"
                              class="peer sr-only"
                              checked={remoteAccessEnabled()}
                              onInput={(event) =>
                                setRemoteAccessEnabled(event.currentTarget.checked)}
                              disabled={remoteAccess().busy}
                            />
                            <div class="h-6 w-11 rounded-full bg-gray-300 transition-colors peer-checked:bg-amber-500 peer-disabled:opacity-50 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-5" />
                          </label>
                        </div>

                        <div class="mt-4 flex items-center justify-between gap-3">
                          <div class="text-[13px] text-gray-500">
                            {remoteAccess().enabled
                              ? "Remote access is currently enabled."
                              : "Remote access is currently disabled."}
                          </div>
                          <button
                            type="button"
                            onClick={() => remoteAccess().onSave(remoteAccessEnabled())}
                            disabled={remoteAccess().busy || !hasPendingChange()}
                            class={secondaryButtonClass}
                          >
                            {remoteAccess().busy ? "Saving..." : "Save"}
                          </button>
                        </div>

                        <Show when={remoteAccess().error?.trim()}>
                          <div class="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
                            {remoteAccess().error}
                          </div>
                        </Show>
                      </div>
                    );
                  }}
                </Show>

                <div class={softCardClass}>
                  <div class="flex items-center gap-2 min-w-0">
                    <div class="ow-icon-tile-muted h-9 w-9 shrink-0 rounded-full">
                      <MessageSquare size={16} />
                    </div>
                    <div class="min-w-0">
                      <h4 class="text-[18px] font-medium tracking-tight text-[#011627]">Connect messaging</h4>
                      <p class="mt-1 truncate text-[14px] text-gray-500">Use this workspace from Slack, Telegram, and others.</p>
                    </div>
                  </div>
                  <button
                    onClick={() => props.onOpenBots?.()}
                    disabled={!props.onOpenBots}
                    class={`${secondaryButtonClass} mt-5 w-full sm:w-auto`}
                  >
                    Setup
                  </button>
                </div>

                <div class="space-y-4">
                  <Show
                    when={primaryAccessFields().length > 0}
                    fallback={
                      <div class={quietCardClass}>
                        <div class="text-[13px] leading-relaxed text-gray-500">
                          Enable remote access and click Save to restart the worker and reveal the live connection details for this workspace.
                        </div>
                      </div>
                    }
                  >
                    <div class={softCardClass}>
                      <div class="mb-4 text-[11px] font-bold uppercase tracking-[0.18em] text-gray-500">Connection details</div>
                      <div class="space-y-4">
                        <For each={primaryAccessFields()}>
                          {(field, index) => renderCredentialField(field, index, "primary")}
                        </For>
                      </div>
                    </div>
                  </Show>
                </div>

                <Show when={collaboratorField()}>
                  {(field) => (
                    <div class="pt-1">
                      <button
                        type="button"
                        class="inline-flex items-center gap-2 rounded-full border border-[#e5e7eb] bg-white px-4 py-2 text-[11px] font-medium text-gray-500 shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_1px_2px_0_rgba(0,0,0,0.04)] transition-colors hover:bg-gray-50 hover:text-gray-700"
                        onClick={() => setCollaboratorExpanded((value) => !value)}
                        aria-expanded={collaboratorExpanded()}
                      >
                        <span>Optional collaborator access</span>
                        <ChevronDown
                          size={13}
                          class={`shrink-0 transition-transform ${collaboratorExpanded() ? "rotate-180" : ""}`}
                        />
                      </button>
                      <Show when={collaboratorExpanded()}>
                        <div class={`${quietCardClass} mt-3`}>
                          <div class="mb-3 text-[12px] text-gray-500">Routine access without permission approvals.</div>
                          {renderCredentialField(field(), () => 0, "collaborator")}
                        </div>
                      </Show>
                    </div>
                  )}
                </Show>

                <Show when={note()}>
                  <div class="px-1 text-[11px] text-gray-500">{note()}</div>
                </Show>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
