import { For, Show } from "solid-js";

import { ChevronDown, Check, Copy, Eye, EyeOff, MessageSquare } from "lucide-solid";

import {
  errorBannerClass,
  iconTileClass,
  inputClass,
  pillGhostClass,
  pillPrimaryClass,
  pillSecondaryClass,
  softCardClass,
  surfaceCardClass,
  warningBannerClass,
} from "./modal-styles";
import type { ShareField } from "./types";

const isInviteField = (label: string) => /invite link/i.test(label);
const isCollaboratorField = (label: string) => /collaborator token/i.test(label);
const isPasswordField = (label: string) => /owner token|connected token|access token|password/i.test(label);
const isWorkerUrlField = (label: string) => /worker url/i.test(label);

const displayFieldLabel = (field: ShareField) => {
  if (isPasswordField(field.label)) return "Password";
  if (isWorkerUrlField(field.label)) return "Worker URL";
  return field.label;
};

export default function ShareWorkspaceAccessPanel(props: {
  fields: ShareField[];
  copiedKey: string | null;
  onCopy: (value: string, key: string) => void;
  revealedByKey: Record<string, boolean>;
  onToggleReveal: (key: string) => void;
  collaboratorExpanded: boolean;
  onToggleCollaboratorExpanded: () => void;
  remoteAccess?: {
    enabled: boolean;
    busy: boolean;
    error?: string | null;
    onSave: (enabled: boolean) => void | Promise<void>;
  };
  remoteAccessEnabled: boolean;
  onRemoteAccessEnabledChange: (value: boolean) => void;
  note?: string | null;
  onOpenBots?: () => void;
}) {
  const accessFields = () => props.fields.filter((field) => !isInviteField(field.label));
  const collaboratorField = () => accessFields().find((field) => isCollaboratorField(field.label)) ?? null;
  const primaryAccessFields = () => accessFields().filter((field) => !isCollaboratorField(field.label));

  const renderCredentialField = (field: ShareField, index: number, keyPrefix: string) => {
    const key = `${keyPrefix}:${field.label}:${index}`;
    const isSecret = Boolean(field.secret);
    const revealed = () => Boolean(props.revealedByKey[key]);

    return (
      <div>
        <label class="mb-1.5 block text-[13px] font-medium text-dls-text">{displayFieldLabel(field)}</label>
        <div class="relative flex items-center gap-2">
          <input
            type={isSecret && !revealed() ? "password" : "text"}
            readonly
            value={field.value || field.placeholder || ""}
            class={`${inputClass} font-mono text-[12px]`}
          />
          <Show when={isSecret}>
            <button
              type="button"
              onClick={() => props.onToggleReveal(key)}
              disabled={!field.value}
              class={pillSecondaryClass}
              title={revealed() ? "Hide password" : "Reveal password"}
            >
              <Show when={revealed()} fallback={<Eye size={14} />}>
                <EyeOff size={14} />
              </Show>
            </button>
          </Show>
          <button
            type="button"
            onClick={() => props.onCopy(field.value, key)}
            disabled={!field.value}
            class={pillSecondaryClass}
            title="Copy"
          >
            <Show when={props.copiedKey === key} fallback={<Copy size={14} />}>
              <Check size={14} class="text-emerald-600" />
            </Show>
          </button>
        </div>
        <Show when={field.hint?.trim()}>
          <p class="mt-1.5 text-[12px] text-dls-secondary">{field.hint}</p>
        </Show>
      </div>
    );
  };

  return (
    <div class="space-y-5 pt-2 animate-in fade-in slide-in-from-right-4 duration-300">
      <div class={warningBannerClass}>
        <span class="leading-relaxed">
          <Show
            when={props.remoteAccess}
            fallback={"Share with trusted people only. These credentials grant live access to this workspace."}
          >
            These credentials grant live access to this workspace. Sharing this workspace remotely may allow anyone with access to your network to control your worker.
          </Show>
        </span>
      </div>

      <Show when={props.remoteAccess}>
        {(remoteAccess) => {
          const hasPendingChange = () => props.remoteAccessEnabled !== remoteAccess().enabled;

          return (
            <div class={surfaceCardClass}>
              <div class="flex items-start justify-between gap-3">
                <div>
                  <h3 class="text-[18px] font-semibold tracking-[-0.3px] text-dls-text">Remote access</h3>
                  <p class="mt-1 text-[14px] leading-relaxed text-dls-secondary">
                    Off by default. Turn this on only when you want this worker reachable from another machine.
                  </p>
                </div>
                <label class="relative inline-flex shrink-0 cursor-pointer items-center">
                  <input
                    type="checkbox"
                    class="peer sr-only"
                    checked={props.remoteAccessEnabled}
                    onInput={(event) => props.onRemoteAccessEnabledChange(event.currentTarget.checked)}
                    disabled={remoteAccess().busy}
                  />
                  <div class="h-6 w-11 rounded-full bg-gray-300 transition-colors peer-checked:bg-[var(--dls-accent)] peer-disabled:opacity-50 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-5" />
                </label>
              </div>

              <div class="mt-4 flex items-center justify-between gap-3">
                <div class="text-[13px] text-dls-secondary">
                  {remoteAccess().enabled
                    ? "Remote access is currently enabled."
                    : "Remote access is currently disabled."}
                </div>
                <button
                  type="button"
                  onClick={() => remoteAccess().onSave(props.remoteAccessEnabled)}
                  disabled={remoteAccess().busy || !hasPendingChange()}
                  class={pillSecondaryClass}
                >
                  {remoteAccess().busy ? "Saving…" : "Save"}
                </button>
              </div>

              <Show when={remoteAccess().error?.trim()}>
                <div class={`mt-4 ${errorBannerClass}`}>{remoteAccess().error}</div>
              </Show>
            </div>
          );
        }}
      </Show>

      <div class={surfaceCardClass}>
        <div class="flex items-center gap-2 min-w-0">
          <div class={`${iconTileClass} h-9 w-9 rounded-full`}>
            <MessageSquare size={16} />
          </div>
          <div class="min-w-0">
            <h4 class="text-[18px] font-semibold tracking-[-0.3px] text-dls-text">Connect messaging</h4>
            <p class="mt-1 truncate text-[14px] text-dls-secondary">Use this workspace from Slack, Telegram, and others.</p>
          </div>
        </div>
        <button type="button" onClick={() => props.onOpenBots?.()} disabled={!props.onOpenBots} class={`${pillSecondaryClass} mt-5`}>
          Setup
        </button>
      </div>

      <Show
        when={primaryAccessFields().length > 0}
        fallback={
          <div class={`${softCardClass} text-[13px] leading-relaxed text-dls-secondary`}>
            Enable remote access and click Save to restart the worker and reveal the live connection details for this workspace.
          </div>
        }
      >
        <div class={surfaceCardClass}>
          <div class="mb-4 text-[13px] font-medium text-dls-text">Connection details</div>
          <div class="space-y-4">
            <For each={primaryAccessFields()}>
              {(field, index) => renderCredentialField(field, index(), "primary")}
            </For>
          </div>
        </div>
      </Show>

      <Show when={collaboratorField()}>
        {(field) => (
          <div class="pt-1">
            <button
              type="button"
              class={pillGhostClass}
              onClick={props.onToggleCollaboratorExpanded}
              aria-expanded={props.collaboratorExpanded}
            >
              <span>Optional collaborator access</span>
              <ChevronDown size={13} class={`shrink-0 transition-transform ${props.collaboratorExpanded ? "rotate-180" : ""}`} />
            </button>
            <Show when={props.collaboratorExpanded}>
              <div class={`${softCardClass} mt-3`}>
                <div class="mb-3 text-[12px] text-dls-secondary">Routine access without permission approvals.</div>
                {renderCredentialField(field(), 0, "collaborator")}
              </div>
            </Show>
          </div>
        )}
      </Show>

      <Show when={props.note?.trim()}>
        <div class="px-1 text-[12px] text-dls-secondary">{props.note}</div>
      </Show>
    </div>
  );
}
