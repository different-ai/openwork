import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  FolderCode,
  MessageSquare,
  MonitorUp,
  Rocket,
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
  publisherBaseUrl?: string;
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
  onShareSkillsSet?: () => void;
  onOpenSingleSkillShare?: () => void;
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
  const note = createMemo(() => props.note?.trim() ?? "");
  const accessFields = createMemo(() => props.fields.filter((field) => !isInviteField(field.label)));
  const collaboratorField = createMemo(() => accessFields().find((field) => isCollaboratorField(field.label)) ?? null);
  const primaryAccessFields = createMemo(() =>
    accessFields().filter((field) => !isCollaboratorField(field.label)),
  );

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

  const renderCredentialField = (field: ShareField, index: () => number, keyPrefix: string) => {
    const key = () => `${keyPrefix}:${field.label}:${index()}`;
    const isSecret = () => Boolean(field.secret);
    const revealed = () => Boolean(revealedByIndex()[index()]);
    return (
      <div class="group">
        <label class="text-[11px] uppercase tracking-wider font-medium text-gray-10 mb-1.5 block">
          {displayFieldLabel(field)}
        </label>
        <div class="relative flex items-center">
          <input
            type={isSecret() && !revealed() ? "password" : "text"}
            readonly
            value={field.value || field.placeholder || ""}
            class="w-full bg-transparent border border-dls-border rounded-md py-2 pl-3 pr-20 text-[12px] font-mono text-dls-text transition-colors outline-none focus:border-[rgba(var(--dls-accent-rgb),0.45)] focus:ring-1 focus:ring-[rgba(var(--dls-accent-rgb),0.18)]"
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
                class="p-1.5 text-gray-10 hover:text-gray-12 hover:bg-gray-3 rounded-md transition-colors disabled:opacity-50"
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
              class="p-1.5 text-gray-10 hover:text-gray-12 hover:bg-gray-3 rounded-md transition-colors disabled:opacity-50"
              title="Copy"
            >
              <Show when={copiedKey() === key()} fallback={<Copy size={14} />}>
                <Check size={14} class="text-emerald-10" />
              </Show>
            </button>
          </div>
        </div>
        <Show when={field.hint && field.hint.trim()}>
          <p class="text-[11px] text-gray-9 mt-1.5">{field.hint}</p>
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
          class="mt-3 w-full rounded-full bg-dls-text px-5 py-3 text-[13px] font-medium text-dls-surface shadow-sm transition-colors hover:bg-gray-12 active:scale-[0.99] disabled:opacity-50"
        >
          {busy ? "Publishing..." : createLabel}
        </button>
      }
    >
      <div class="flex items-center gap-2 animate-in fade-in zoom-in-95 duration-200">
        <input
          type="text"
          readonly
          value={value!}
          class="flex-1 bg-transparent border border-dls-border rounded-md py-1.5 px-2.5 text-[12px] font-mono text-gray-11 outline-none focus:border-[rgba(var(--dls-accent-rgb),0.45)] focus:ring-1 focus:ring-[rgba(var(--dls-accent-rgb),0.18)]"
        />
        <button
          onClick={() => handleCopy(value ?? "", copyKey)}
          class="p-1.5 hover:bg-gray-3 text-gray-11 hover:text-gray-12 rounded-md transition-colors"
          title="Copy link"
        >
          <Show when={copiedKey() === copyKey} fallback={<Copy size={14} />}>
            <Check size={14} class="text-emerald-10" />
          </Show>
        </button>
      </div>
      <button
        onClick={() => regenerate?.()}
        disabled={busy}
        class="mt-3 w-full rounded-full bg-gray-2 px-4 py-2 text-[12px] font-medium text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12"
      >
        {busy ? "Publishing..." : regenerateLabel}
      </button>
    </Show>
  );

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/45 px-3 pt-[12vh] md:px-6 font-sans animate-in fade-in duration-200">
        <div
          class="w-full max-w-[580px] rounded-2xl border border-dls-border bg-dls-surface shadow-[0_20px_70px_rgba(0,0,0,0.45)] overflow-hidden animate-in fade-in zoom-in-95 duration-300 relative flex flex-col max-h-[75vh]"
          role="dialog"
          aria-modal="true"
        >
          <div class="border-b border-dls-border px-4 py-3 relative shrink-0">
            <button
              onClick={props.onClose}
              class="absolute top-3 right-3 p-1 text-gray-9 hover:text-gray-12 hover:bg-gray-3 rounded-md transition-colors"
              aria-label="Close"
              title="Close"
            >
              <X size={16} />
            </button>

            <Show when={activeView() !== "chooser"}>
              <button
                onClick={goBack}
                class="absolute top-3 left-3 p-1 text-gray-9 hover:text-gray-12 hover:bg-gray-3 rounded-md transition-colors"
                aria-label="Back"
                title="Back to share options"
              >
                <ArrowLeft size={16} />
              </button>
            </Show>

            <div class="flex items-center gap-2" classList={{ "ml-6": activeView() !== "chooser" }}>
              <div class="min-w-0">
                <h2 class="text-[14px] font-medium text-dls-text tracking-tight truncate">
                  <Show when={activeView() === "chooser"}>{title()}</Show>
                  <Show when={activeView() === "template"}>Share a template</Show>
                  <Show when={activeView() === "template-public"}>Public template</Show>
                  <Show when={activeView() === "template-team"}>Share with team</Show>
                  <Show when={activeView() === "access"}>Access workspace remotely</Show>
                </h2>
                <div class="mt-0.5 text-[12px] text-gray-10 truncate">{props.workspaceName}</div>
              </div>
            </div>
          </div>

          <div class="px-4 pb-6 flex-1 overflow-y-auto scrollbar-hide">
            <Show when={activeView() === "chooser"}>
              <div class="space-y-2 pt-4 animate-in fade-in slide-in-from-bottom-3 duration-300">
                <button
                  type="button"
                  onClick={() => setActiveView("template")}
                  class="w-full text-left rounded-xl p-3 hover:bg-dls-hover transition-colors group flex items-start gap-3"
                >
                  <div class="mt-0.5 text-gray-10 group-hover:text-gray-12 transition-colors shrink-0">
                    <Rocket size={18} />
                  </div>
                  <div class="flex-1">
                    <h3 class="text-[13px] font-medium text-dls-text">Share a template</h3>
                    <p class="text-[12px] text-gray-10 leading-snug mt-0.5 pr-4">
                      Share your setup and defaults so someone else can start from the same environment.
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveView("access")}
                  class="w-full text-left rounded-xl p-3 hover:bg-dls-hover transition-colors group flex items-start gap-3"
                >
                  <div class="mt-0.5 text-gray-10 group-hover:text-gray-12 transition-colors shrink-0">
                    <MonitorUp size={18} />
                  </div>
                  <div class="flex-1">
                    <h3 class="text-[13px] font-medium text-dls-text">Access workspace remotely</h3>
                    <p class="text-[12px] text-gray-10 leading-snug mt-0.5 pr-4">
                      Copy the connection details needed to reach this live workspace from another machine or messaging surface.
                    </p>
                  </div>
                </button>
              </div>
            </Show>

            <Show when={activeView() === "template"}>
              <div class="space-y-6 pt-4 animate-in fade-in slide-in-from-right-4 duration-300">
                <div class="text-[12px] text-gray-10">
                  Share a reusable setup without granting live access to this running workspace.
                </div>

                <div class="space-y-2">
                  <button
                    type="button"
                    onClick={() => setActiveView("template-public")}
                    class="w-full text-left rounded-xl p-3 hover:bg-dls-hover transition-colors group flex items-start gap-3"
                  >
                    <div class="mt-0.5 text-gray-10 group-hover:text-gray-12 transition-colors shrink-0">
                      <Rocket size={18} />
                    </div>
                    <div class="flex-1">
                      <h3 class="text-[13px] font-medium text-dls-text">Public</h3>
                      <p class="text-[12px] text-gray-10 leading-snug mt-0.5 pr-4">
                        Create a public share link anyone can use to start from this template.
                      </p>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveView("template-team")}
                    class="w-full text-left rounded-xl p-3 hover:bg-dls-hover transition-colors group flex items-start gap-3"
                  >
                    <div class="mt-0.5 text-gray-10 group-hover:text-gray-12 transition-colors shrink-0">
                      <Users size={18} />
                    </div>
                    <div class="flex-1">
                      <h3 class="text-[13px] font-medium text-dls-text">Share with team</h3>
                      <p class="text-[12px] text-gray-10 leading-snug mt-0.5 pr-4">
                        Save this workspace template to your active OpenWork Cloud organization.
                      </p>
                    </div>
                  </button>
                </div>
              </div>
            </Show>

            <Show when={activeView() === "template-public"}>
              <div class="space-y-6 pt-4 animate-in fade-in slide-in-from-right-4 duration-300">
                <div class="text-[12px] text-gray-10">
                  Share this workspace as a public template link.
                </div>

                <div class="space-y-3">
                  <div class="flex items-center gap-2 mb-1">
                    <FolderCode size={16} class="text-gray-9 shrink-0" />
                    <div class="flex-1">
                      <h3 class="text-[13px] font-medium text-dls-text">Workspace template</h3>
                      <p class="text-[12px] text-gray-10 leading-tight mt-0.5">Share the core setup and workspace defaults.</p>
                    </div>
                  </div>

                  <Show when={props.shareWorkspaceProfileError?.trim()}>
                    <div class="rounded-md border border-red-6/40 bg-red-3/30 px-3 py-2 mb-2 text-[12px] text-red-11">
                      {props.shareWorkspaceProfileError}
                    </div>
                  </Show>
                  <Show when={props.shareWorkspaceProfileDisabledReason?.trim()}>
                    <div class="text-[12px] text-gray-9 mb-2">{props.shareWorkspaceProfileDisabledReason}</div>
                  </Show>

                  {renderGeneratedLink(
                    props.shareWorkspaceProfileUrl,
                    "share-workspace-profile",
                    props.onShareWorkspaceProfile,
                    props.shareWorkspaceProfileBusy,
                    "Create Template Link",
                    "Regenerate Link",
                    props.onShareWorkspaceProfile,
                    props.shareWorkspaceProfileDisabledReason,
                  )}
                </div>
              </div>
            </Show>

            <Show when={activeView() === "template-team"}>
              <div class="space-y-6 pt-4 animate-in fade-in slide-in-from-right-4 duration-300">
                <div class="text-[12px] text-gray-10">
                  Save this template to your active OpenWork Cloud organization so teammates can open it later from Cloud settings.
                </div>

                <div class="space-y-4 rounded-[20px] border border-dls-border bg-gray-2/30 px-4 py-4">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="rounded-full border border-gray-6/60 bg-gray-1/40 px-2.5 py-1 text-[11px] font-medium text-gray-11">
                      {props.shareWorkspaceProfileToTeamOrgName?.trim() || "Active Cloud org"}
                    </span>
                  </div>

                  <div>
                    <label class="text-[11px] uppercase tracking-wider font-medium text-gray-10 mb-1.5 block">
                      Template name
                    </label>
                    <input
                      type="text"
                      value={teamTemplateName()}
                      onInput={(event) => setTeamTemplateName(event.currentTarget.value)}
                      class="w-full bg-transparent border border-dls-border rounded-md py-2 px-3 text-[13px] text-dls-text transition-colors outline-none focus:border-[rgba(var(--dls-accent-rgb),0.45)] focus:ring-1 focus:ring-[rgba(var(--dls-accent-rgb),0.18)]"
                      placeholder={`${props.workspaceName.trim() || "Workspace"} template`}
                    />
                  </div>

                  <Show when={props.shareWorkspaceProfileToTeamError?.trim()}>
                    <div class="rounded-md border border-red-6/40 bg-red-3/30 px-3 py-2 text-[12px] text-red-11">
                      {props.shareWorkspaceProfileToTeamError}
                    </div>
                  </Show>

                  <Show when={props.shareWorkspaceProfileToTeamSuccess?.trim()}>
                    <div class="rounded-md border border-emerald-6/40 bg-emerald-3/30 px-3 py-2 text-[12px] text-emerald-11">
                      {props.shareWorkspaceProfileToTeamSuccess}
                    </div>
                  </Show>

                  <Show when={props.shareWorkspaceProfileToTeamDisabledReason?.trim()}>
                    <div class="text-[12px] text-gray-9">{props.shareWorkspaceProfileToTeamDisabledReason}</div>
                  </Show>

                  <button
                    onClick={() => props.onShareWorkspaceProfileToTeam?.(teamTemplateName())}
                    disabled={
                      Boolean(props.shareWorkspaceProfileToTeamDisabledReason) ||
                      !props.onShareWorkspaceProfileToTeam ||
                      props.shareWorkspaceProfileToTeamBusy ||
                      !teamTemplateName().trim()
                    }
                    class="w-full rounded-full bg-dls-text px-5 py-3 text-[13px] font-medium text-dls-surface shadow-sm transition-colors hover:bg-gray-12 active:scale-[0.99] disabled:opacity-50"
                  >
                    {props.shareWorkspaceProfileToTeamBusy ? "Saving..." : "Save to team"}
                  </button>
                </div>
              </div>
            </Show>

            <Show when={activeView() === "access"}>
              <div class="space-y-6 pt-4 animate-in fade-in slide-in-from-right-4 duration-300">
                <div class="rounded-md border border-amber-6/40 bg-amber-3/30 px-3 py-2 text-[12px] text-amber-11 flex items-start gap-2">
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
                      <div class="rounded-[20px] border border-dls-border bg-gray-2/30 px-4 py-4 space-y-4">
                        <div class="flex items-start justify-between gap-3">
                          <div>
                            <h3 class="text-[13px] font-medium text-dls-text">Remote access</h3>
                            <p class="text-[12px] text-gray-10 mt-0.5 leading-relaxed">
                              Off by default. Turn this on only when you want this worker reachable from another machine.
                            </p>
                          </div>
                          <label class="relative inline-flex items-center cursor-pointer shrink-0">
                            <input
                              type="checkbox"
                              class="sr-only peer"
                              checked={remoteAccessEnabled()}
                              onInput={(event) =>
                                setRemoteAccessEnabled(event.currentTarget.checked)}
                              disabled={remoteAccess().busy}
                            />
                            <div class="w-11 h-6 rounded-full bg-gray-6 transition-colors peer-checked:bg-amber-8 peer-disabled:opacity-50 after:absolute after:top-[2px] after:left-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-5" />
                          </label>
                        </div>

                        <div class="flex items-center justify-between gap-3">
                          <div class="text-[12px] text-gray-10">
                            {remoteAccess().enabled
                              ? "Remote access is currently enabled."
                              : "Remote access is currently disabled."}
                          </div>
                          <button
                            type="button"
                            onClick={() => remoteAccess().onSave(remoteAccessEnabled())}
                            disabled={remoteAccess().busy || !hasPendingChange()}
                            class="px-3 py-1.5 bg-gray-2 hover:bg-gray-3 rounded-md text-[12px] font-medium text-dls-text transition-colors disabled:opacity-50"
                          >
                            {remoteAccess().busy ? "Saving..." : "Save"}
                          </button>
                        </div>

                        <Show when={remoteAccess().error?.trim()}>
                          <div class="rounded-md border border-red-6/40 bg-red-3/30 px-3 py-2 text-[12px] text-red-11">
                            {remoteAccess().error}
                          </div>
                        </Show>
                      </div>
                    );
                  }}
                </Show>

                <div class="flex items-center justify-between gap-3 rounded-[20px] border border-dls-border bg-gray-2/30 px-3 py-3">
                  <div class="flex items-center gap-2 min-w-0">
                    <MessageSquare size={16} class="text-gray-9 shrink-0" />
                    <div class="min-w-0">
                      <h4 class="text-[13px] font-medium text-dls-text">Connect messaging</h4>
                      <p class="text-[12px] text-gray-10 mt-0.5 truncate">Use this workspace from Slack, Telegram, and others.</p>
                    </div>
                  </div>
                  <button
                    onClick={() => props.onOpenBots?.()}
                    disabled={!props.onOpenBots}
                    class="px-3 py-1.5 bg-gray-2 hover:bg-gray-3 rounded-md text-[12px] font-medium text-dls-text transition-colors disabled:opacity-50"
                  >
                    Setup
                  </button>
                </div>

                <div class="space-y-4">
                  <Show when={primaryAccessFields().length > 0} fallback={
                    <div class="rounded-[20px] border border-dls-border bg-gray-2/20 px-4 py-4 text-[12px] text-gray-10 leading-relaxed">
                      Enable remote access and click Save to restart the worker and reveal the live connection details for this workspace.
                    </div>
                  }>
                  <For each={primaryAccessFields()}>
                    {(field, index) => renderCredentialField(field, index, "primary")}
                  </For>
                  </Show>
                </div>

                <Show when={collaboratorField()}>
                  {(field) => (
                    <div class="pt-1">
                      <button
                        type="button"
                        class="inline-flex items-center gap-2 rounded-full border border-dls-border/70 bg-gray-2/30 px-3 py-1.5 text-[11px] font-medium text-gray-10 transition-colors hover:border-dls-border hover:bg-gray-2/60 hover:text-gray-11"
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
                        <div class="mt-3 rounded-[20px] border border-dls-border bg-gray-2/30 px-3 py-3">
                          <div class="mb-2 text-[11px] text-gray-9">Routine access without permission approvals.</div>
                          {renderCredentialField(field(), () => 0, "collaborator")}
                        </div>
                      </Show>
                    </div>
                  )}
                </Show>

                <Show when={note()}>
                  <div class="px-1 text-[11px] text-gray-9">{note()}</div>
                </Show>

              </div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
