/** @jsxImportSource react */
import {
  Check,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
} from "lucide-react";

import {
  errorBannerClass,
  iconTileClass,
  inputClass,
  pillGhostClass,
  pillSecondaryClass,
  softCardClass,
  surfaceCardClass,
  warningBannerClass,
} from "./modal-styles";
import type { ShareField } from "./types";

const isInviteField = (label: string) => /invite link/i.test(label);
const isCollaboratorField = (label: string) =>
  /collaborator token/i.test(label);
const isPasswordField = (label: string) =>
  /owner token|connected token|access token|password/i.test(label);
const isWorkerUrlField = (label: string) => /worker url/i.test(label);

const displayFieldLabel = (field: ShareField) => {
  if (isPasswordField(field.label)) return "Password";
  if (isWorkerUrlField(field.label)) return "Worker URL";
  return field.label;
};

export type ShareWorkspaceAccessPanelProps = {
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
    status?: string | null;
    onSave: (enabled: boolean) => void | Promise<void>;
  };
  remoteAccessEnabled: boolean;
  onRemoteAccessEnabledChange: (value: boolean) => void;
  note?: string | null;
};

export function ShareWorkspaceAccessPanel(
  props: ShareWorkspaceAccessPanelProps,
) {
  const accessFields = props.fields.filter(
    (field) => !isInviteField(field.label),
  );
  const collaboratorField =
    accessFields.find((field) => isCollaboratorField(field.label)) ?? null;
  const primaryAccessFields = accessFields.filter(
    (field) => !isCollaboratorField(field.label),
  );
  const remoteAccessNeedsEnable = Boolean(
    props.remoteAccess && !props.remoteAccess.enabled && !props.remoteAccessEnabled,
  );
  const remoteSaveDisabled = props.remoteAccess
    ? props.remoteAccess.busy ||
      (props.remoteAccess.enabled &&
        props.remoteAccessEnabled === props.remoteAccess.enabled)
    : true;
  const remoteSaveLabel = props.remoteAccess?.busy
    ? "Saving…"
    : remoteAccessNeedsEnable
      ? "Enable remote access"
      : props.remoteAccess?.enabled === false && props.remoteAccessEnabled
        ? "Save & restart worker"
        : "Save";

  const renderCredentialField = (
    field: ShareField,
    index: number,
    keyPrefix: string,
  ) => {
    const key = `${keyPrefix}:${field.label}:${index}`;
    const isSecret = Boolean(field.secret);
    const revealed = Boolean(props.revealedByKey[key]);

    return (
      <div>
        <label className="mb-1.5 block text-[13px] font-medium text-dls-text">
          {displayFieldLabel(field)}
        </label>
        <div className="relative flex items-center gap-2">
          <input
            type={isSecret && !revealed ? "password" : "text"}
            readOnly
            value={field.value || field.placeholder || ""}
            className={`${inputClass} font-mono text-[12px]`}
          />
          {isSecret ? (
            <button
              type="button"
              onClick={() => props.onToggleReveal(key)}
              disabled={!field.value}
              className={pillSecondaryClass}
              title={revealed ? "Hide password" : "Reveal password"}
            >
              {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => props.onCopy(field.value, key)}
            disabled={!field.value}
            className={pillSecondaryClass}
            title="Copy"
          >
            {props.copiedKey === key ? (
              <Check size={14} className="text-emerald-600" />
            ) : (
              <Copy size={14} />
            )}
          </button>
        </div>
        {field.hint?.trim() ? (
          <p className="mt-1.5 text-[12px] text-dls-secondary">{field.hint}</p>
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-5 pt-2 animate-in fade-in slide-in-from-right-4 duration-300">
      <div className={warningBannerClass}>
        <span className="leading-relaxed">
          {props.remoteAccess
            ? "These credentials grant live access to this workspace. Sharing this workspace remotely may allow anyone with access to your network to control your worker."
            : "Share with trusted people only. These credentials grant live access to this workspace."}
        </span>
      </div>

      {props.remoteAccess ? (
        <div className={surfaceCardClass}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-[18px] font-semibold tracking-[-0.3px] text-dls-text">
                Remote access
              </h3>
              <p className="mt-1 text-[14px] leading-relaxed text-dls-secondary">
                Off by default. Turn this on only when you want this worker
                reachable from another machine.
              </p>
            </div>
            <label className="relative inline-flex shrink-0 cursor-pointer items-center">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={props.remoteAccessEnabled}
                onChange={(event) =>
                  props.onRemoteAccessEnabledChange(event.currentTarget.checked)
                }
                disabled={props.remoteAccess.busy}
              />
              <div className="h-6 w-11 rounded-full bg-gray-300 transition-colors peer-checked:bg-[var(--dls-accent)] peer-disabled:opacity-50 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-5" />
            </label>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <div className="text-[13px] text-dls-secondary">
              {props.remoteAccess.status?.trim() ||
                (props.remoteAccess.enabled
                  ? "Remote access is currently enabled."
                  : "Remote access is currently disabled.")}
            </div>
            <button
              type="button"
              onClick={() => {
                if (remoteAccessNeedsEnable) {
                  props.onRemoteAccessEnabledChange(true);
                  return;
                }
                void props.remoteAccess?.onSave(props.remoteAccessEnabled);
              }}
              disabled={remoteSaveDisabled}
              className={pillSecondaryClass}
            >
              {remoteSaveLabel}
            </button>
          </div>

          {props.remoteAccess.error?.trim() ? (
            <div className={`mt-4 ${errorBannerClass}`}>
              {props.remoteAccess.error}
            </div>
          ) : null}
        </div>
      ) : null}

      {primaryAccessFields.length > 0 ? (
        <div className={surfaceCardClass}>
          <div className="mb-4 text-[13px] font-medium text-dls-text">
            Connection details
          </div>
          <div className="space-y-4">
            {primaryAccessFields.map((field, index) => (
              <div key={`${field.label}-${index}`}>
                {renderCredentialField(field, index, "primary")}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div
          className={`${softCardClass} text-[13px] leading-relaxed text-dls-secondary`}
        >
          Enable remote access and click Save to restart the worker and reveal
          the live connection details for this workspace.
        </div>
      )}

      {collaboratorField ? (
        <div className="pt-1">
          <button
            type="button"
            className={pillGhostClass}
            onClick={props.onToggleCollaboratorExpanded}
            aria-expanded={props.collaboratorExpanded}
          >
            <span>Optional collaborator access</span>
            <ChevronDown
              size={13}
              className={`shrink-0 transition-transform ${
                props.collaboratorExpanded ? "rotate-180" : ""
              }`}
            />
          </button>
          {props.collaboratorExpanded ? (
            <div className={`${softCardClass} mt-3`}>
              <div className="mb-3 text-[12px] text-dls-secondary">
                Routine access without permission approvals.
              </div>
              {renderCredentialField(collaboratorField, 0, "collaborator")}
            </div>
          ) : null}
        </div>
      ) : null}

      {props.note?.trim() ? (
        <div className="px-1 text-[12px] text-dls-secondary">{props.note}</div>
      ) : null}
    </div>
  );
}
