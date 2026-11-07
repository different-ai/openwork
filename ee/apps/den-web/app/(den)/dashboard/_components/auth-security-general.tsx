"use client";

import { useEffect, useState } from "react";
import {
  ADMIN_REAUTH_MINUTES,
  type AdminReauthMinutes,
  DEFAULT_ADMIN_REAUTH_MINUTES,
  DEFAULT_MAX_SESSION_LENGTH_DAYS,
  DEFAULT_SESSION_LENGTH_HOURS,
  getOrgAccessFlags,
  getSessionSecuritySettingsFromMetadata,
  isAdminReauthMinutes,
  isMaxSessionLengthDays,
  MAX_SESSION_LENGTH_DAYS,
  type MaxSessionLengthDays,
  isSessionLengthHours,
  permissionLockReason,
  SESSION_LENGTH_HOURS,
  type SessionLengthHours,
  type SessionSecuritySettings,
} from "../../_lib/den-org";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenNotice } from "../../_components/ui/notice";
import { DenSelect } from "../../_components/ui/select";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

// The dropdown sits beside the text, and moves below it when the card is too narrow for both.
const ROW_CLASS = "flex flex-col gap-3 rounded-[24px] border border-gray-200 bg-white px-5 py-4 @lg:flex-row @lg:items-start @lg:justify-between @lg:gap-4";
const ROW_TEXT_CLASS = "grid min-w-0 flex-1 gap-1";
const ROW_CONTROL_CLASS = "w-full shrink-0 @lg:w-[220px]";

function withDefault(label: string, isDefault: boolean) {
  return isDefault ? `${label} (default)` : label;
}

export function sessionLengthLabel(hours: SessionLengthHours): string {
  const label = hours < 24 ? `${hours} hours` : hours === 24 ? "1 day" : `${hours / 24} days`;
  return withDefault(label, hours === DEFAULT_SESSION_LENGTH_HOURS);
}

export function maxSessionLengthLabel(days: MaxSessionLengthDays): string {
  return withDefault(days === 1 ? "1 day" : `${days} days`, days === DEFAULT_MAX_SESSION_LENGTH_DAYS);
}

export function adminReauthLabel(minutes: AdminReauthMinutes): string {
  if (minutes === 0) return "Disabled";
  const label = minutes < 60
    ? `${minutes} minutes`
    : minutes === 60
      ? "1 hour"
      : minutes < 1440
        ? `${minutes / 60} hours`
        : "1 day";
  return withDefault(label, minutes === DEFAULT_ADMIN_REAUTH_MINUTES);
}

/**
 * Settings › Auth & Security › General (sessionSecuritySettings): how long
 * sign-ins last without activity and at most, and how recently an admin must have signed
 * in before sensitive changes (the "Confirm your identity" dialog).
 */
export function AuthSecurityGeneral() {
  const { orgContext, mutationBusy, updateOrganizationSettings } = useOrgDashboard();
  const metadata = orgContext?.organization.metadata ?? null;
  const [draft, setDraft] = useState<SessionSecuritySettings>(() => getSessionSecuritySettingsFromMetadata(metadata));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(getSessionSecuritySettingsFromMetadata(metadata));
  }, [metadata]);

  if (!orgContext) return null;

  const canManageSettings = getOrgAccessFlags(
    orgContext.currentMember.role,
    orgContext.currentMember.isOwner,
    orgContext.currentMember.permissions,
  ).canManageSettings;
  const current = getSessionSecuritySettingsFromMetadata(metadata);
  const changes = {
    ...(draft.sessionLengthHours !== current.sessionLengthHours ? { sessionLengthHours: draft.sessionLengthHours } : {}),
    ...(draft.maxSessionLengthDays !== current.maxSessionLengthDays ? { maxSessionLengthDays: draft.maxSessionLengthDays } : {}),
    ...(draft.adminReauthMinutes !== current.adminReauthMinutes ? { adminReauthMinutes: draft.adminReauthMinutes } : {}),
  };
  const dirty = Object.keys(changes).length > 0;

  function updateDraft(next: SessionSecuritySettings) {
    setError(null);
    setSaved(false);
    setDraft(next);
  }

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await updateOrganizationSettings(changes);
      setSaved(true);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not save these settings.");
    }
  }

  return (
    <form onSubmit={handleSave} data-testid="auth-security-general">
      <DenCard size="spacious" className="@container grid gap-6">
        <div className="grid gap-2">
          <h2 className="text-[24px] font-semibold tracking-[-0.04em] text-gray-900">Sessions</h2>
          <p className="text-[14px] text-gray-500">How long people stay signed in, and when admins confirm it&apos;s them.</p>
        </div>

        {error ? <DenNotice message={error} tone="error" /> : null}

        <div className={ROW_CLASS} data-testid="session-length-row">
          <div className={ROW_TEXT_CLASS}>
            <p className="text-[15px] font-medium text-gray-900">Session length</p>
            <p className="text-[13px] text-gray-500">
              User sessions will be automatically closed after this much inactivity. This includes the desktop app.
            </p>
          </div>
          <div className={ROW_CONTROL_CLASS}>
            <DenSelect
              aria-label="Session length"
              value={String(draft.sessionLengthHours)}
              disabled={!canManageSettings}
              onChange={(event) => {
                const hours = Number(event.target.value);
                if (isSessionLengthHours(hours)) updateDraft({ ...draft, sessionLengthHours: hours });
              }}
              menuWidth="trigger"
            >
              {SESSION_LENGTH_HOURS.map((hours) => (
                <option key={hours} value={String(hours)}>{sessionLengthLabel(hours)}</option>
              ))}
            </DenSelect>
          </div>
        </div>

        <div className={ROW_CLASS} data-testid="max-session-length-row">
          <div className={ROW_TEXT_CLASS}>
            <p className="text-[15px] font-medium text-gray-900">Maximum Session Length</p>
            <p className="text-[13px] text-gray-500">
              Users will have to sign in at least once every period, however active they are. This includes the desktop app.
            </p>
          </div>
          <div className={ROW_CONTROL_CLASS}>
            <DenSelect
              aria-label="Maximum Session Length"
              value={String(draft.maxSessionLengthDays)}
              disabled={!canManageSettings}
              onChange={(event) => {
                const days = Number(event.target.value);
                if (isMaxSessionLengthDays(days)) updateDraft({ ...draft, maxSessionLengthDays: days });
              }}
              menuWidth="trigger"
            >
              {MAX_SESSION_LENGTH_DAYS.map((days) => (
                <option key={days} value={String(days)}>{maxSessionLengthLabel(days)}</option>
              ))}
            </DenSelect>
          </div>
        </div>

        <div className={ROW_CLASS} data-testid="admin-reauth-row">
          <div className={ROW_TEXT_CLASS}>
            <p className="text-[15px] font-medium text-gray-900">Enforce fresh Admin sessions</p>
            <p className="text-[13px] text-gray-500">
              Ensure admins have reauthenticated within the time frame before allowing certain actions, such as changing security settings, roles or API keys.
            </p>
          </div>
          <div className={ROW_CONTROL_CLASS}>
            <DenSelect
              aria-label="Enforce fresh Admin sessions"
              value={String(draft.adminReauthMinutes)}
              disabled={!canManageSettings}
              onChange={(event) => {
                const minutes = Number(event.target.value);
                if (isAdminReauthMinutes(minutes)) updateDraft({ ...draft, adminReauthMinutes: minutes });
              }}
              menuWidth="trigger"
            >
              {ADMIN_REAUTH_MINUTES.map((minutes) => (
                <option key={minutes} value={String(minutes)}>{adminReauthLabel(minutes)}</option>
              ))}
            </DenSelect>
          </div>
        </div>

        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-gray-500" role="status">
            {!canManageSettings
              ? `Read only. ${permissionLockReason("organization.update")}`
              : saved && !dirty
                ? "Session settings saved."
                : null}
          </p>
          <DenButton
            type="submit"
            loading={mutationBusy === "update-organization-settings"}
            disabled={!canManageSettings || !dirty}
          >
            Save
          </DenButton>
        </div>
      </DenCard>
    </form>
  );
}
