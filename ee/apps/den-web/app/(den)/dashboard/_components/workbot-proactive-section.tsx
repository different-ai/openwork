"use client";

import Link from "next/link";
import { Lock } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import {
  AGENT_INSTRUCTIONS_MAX,
  AGENT_RESPONSIBILITIES,
  AGENT_RESPONSIBILITY_COPY,
  WORKBOT_PROACTIVE_DAILY_CAPS,
  WORKBOT_PROACTIVE_LEAD_MINUTES,
  type AgentResponsibility,
  type WorkbotProactiveSettingsInput,
  type WorkbotProactiveView,
} from "@openwork/types/den/workbot-proactive";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenSegmented } from "../../_components/ui/segmented";
import { DenSelect } from "../../_components/ui/select";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { DenSwitch } from "../../_components/ui/switch";
import { DenTextarea } from "../../_components/ui/textarea";
import { agentsSwitchLabel, type AgentPolicyScope } from "./workbot-agent-scope";
import type { WorkbotAgentsPart } from "./workbot-settings-tabs-model";
import { useSaveWorkbotProactive, useWorkbotProactive } from "./workbot-proactive-data";
import { PROACTIVE_PREVIEW_KINDS, WorkbotProactivePreview } from "./workbot-proactive-preview";
import { WorkbotProactiveSources } from "./workbot-proactive-sources";
import { WorkbotAgentBriefPanel } from "./workbot-agent-brief-panel";
import { getLibraryConnectorRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

/**
 * Manage › Workbot › Your agent: every member gets a background agent that reads their calendar, email, team chat and
 * the connections they turn on, on a schedule, and messages them only when something needs them. One switch for the
 * organization, what agents tell people about, where messages go, when and how often, a preview, and what agents read.
 *
 * Members › Teams › Everyone (or a team) › Workbot shows the same section for a `scope`: Everyone's policy, or one
 * team's own, which starts from Everyone's the first time the team changes a control.
 */

const EVERYONE: AgentPolicyScope = { kind: "everyone" };

function hourLabel(hour: number) {
  const h = hour % 24;
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
}

function leadLabel(minutes: number) {
  return minutes === 60 ? "1 hour before" : `${minutes} min before`;
}

function Row({ label, labelId, note, children, testId }: { label: string; labelId?: string; note?: React.ReactNode; children: React.ReactNode; testId?: string }) {
  return (
    <div className="px-6 py-3" data-testid={testId}>
      <div className="flex min-h-[42px] flex-wrap items-center justify-between gap-3">
        <span id={labelId} className="text-[13px] font-medium text-gray-900">{label}</span>
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">{children}</div>
      </div>
      {note ? (
        <p className="mt-1 flex items-center gap-1.5 text-[12px] text-gray-500">
          <Lock size={12} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
          <span>{note}</span>
        </p>
      ) : null}
    </div>
  );
}

function InstructionsRow({ value, version, locked, onSave }: { value: string; version: number; locked: boolean; onSave: (instructions: string) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const changed = draft.trim() !== value.trim();
  return (
    <div className="grid gap-2 px-6 py-3" data-testid="workbot-proactive-instructions">
      <div className="flex min-h-[28px] items-center justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-medium text-gray-900">Instructions for every agent</label>
        <span className="text-[12px] text-gray-500">{`Version ${version}`}</span>
      </div>
      <DenTextarea id={id} rows={2} maxLength={AGENT_INSTRUCTIONS_MAX} value={draft} disabled={locked}
        placeholder="Ignore newsletters and automated alerts."
        onChange={(event) => setDraft(event.target.value)} />
      {changed ? (
        <div className="flex justify-end gap-2">
          <DenButton variant="secondary" size="sm" onClick={() => setDraft(value)}>Discard</DenButton>
          <DenButton size="sm" disabled={locked} onClick={() => onSave(draft.trim())}>Save instructions</DenButton>
        </div>
      ) : null}
    </div>
  );
}

export function WorkbotProactivePanel({
  view,
  canManage,
  saving,
  onChange,
  connectorsHref,
  initialPreview = "morning_brief",
  scope = EVERYONE,
}: {
  view: WorkbotProactiveView;
  canManage: boolean;
  saving: boolean;
  onChange: (change: WorkbotProactiveSettingsInput) => void;
  connectorsHref: string;
  initialPreview?: AgentResponsibility;
  /** Whose policy the rows show: Everyone's, or one team's. */
  scope?: AgentPolicyScope;
}) {
  const ids = { destination: useId(), days: useId(), cap: useId(), members: useId() };
  const [preview, setPreview] = useState<AgentResponsibility>(initialPreview);
  // With Your agent's brief on (the server sends `brief`), one rhythm and a text replace the message types.
  if (view.brief) return <WorkbotAgentBriefPanel view={view} brief={view.brief} canManage={canManage} saving={saving} onChange={onChange} connectorsHref={connectorsHref} scope={scope} />;
  const switchLabel = agentsSwitchLabel(scope);
  const { settings, template, slackReady, runnerReady } = view;
  const locked = !canManage || saving;
  const switchNote = !runnerReady
    ? "Needs the headless runner. Ask your deployment administrator."
    : !settings.destination
      ? "Choose where messages go first."
      : !slackReady
        ? "Needs the Slack app first."
        : null;

  return (
    <div className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-100 bg-white" data-testid="workbot-proactive-panel">
      <Row label={switchLabel} testId="workbot-proactive-enabled" note={switchNote}>
        <DenSwitch
          aria-label={switchLabel}
          checked={settings.enabled}
          disabled={locked || (Boolean(switchNote) && !settings.enabled)}
          onChange={(enabled) => onChange({ enabled })}
        />
      </Row>

      <Row
        label="Send messages to"
        labelId={ids.destination}
        testId="workbot-proactive-destination"
        note={slackReady ? null : (
          <>
            Needs the Slack app.{" "}
            <Link href={connectorsHref} className="rounded text-gray-700 underline underline-offset-2 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
              Set it up in Connectors
            </Link>
          </>
        )}
      >
        <img src="/integrations/slack.svg" alt="" className="h-4 w-4" />
        <div className="w-56">
          <DenSelect
            aria-labelledby={ids.destination}
            menuWidth="trigger"
            value={settings.destination ?? "none"}
            disabled={locked}
            onChange={(event) => onChange({ destination: event.target.value === "workbot_dm" ? "workbot_dm" : null })}
          >
            <option value="workbot_dm">A DM from Workbot</option>
            <option value="none">Nowhere yet</option>
          </DenSelect>
        </div>
      </Row>

      {AGENT_RESPONSIBILITIES.map((responsibility) => (
        <Row key={responsibility} label={AGENT_RESPONSIBILITY_COPY[responsibility].label} testId={`workbot-proactive-${responsibility}`}>
          {responsibility === "meeting_prep" && template.responsibilities.meeting_prep ? (
            <div className="w-40">
              <DenSelect aria-label="How early before meetings" menuWidth="trigger" value={String(settings.leadMinutes)} disabled={locked}
                onChange={(event) => {
                  const minutes = WORKBOT_PROACTIVE_LEAD_MINUTES.find((value) => String(value) === event.target.value);
                  if (minutes) onChange({ leadMinutes: minutes });
                }}>
                {WORKBOT_PROACTIVE_LEAD_MINUTES.map((minutes) => (
                  <option key={minutes} value={String(minutes)}>{leadLabel(minutes)}</option>
                ))}
              </DenSelect>
            </div>
          ) : null}
          <DenSwitch
            aria-label={AGENT_RESPONSIBILITY_COPY[responsibility].label}
            checked={template.responsibilities[responsibility]}
            disabled={locked}
            onChange={(on) => onChange({ responsibilities: { [responsibility]: on } })}
          />
        </Row>
      ))}

      <InstructionsRow value={template.instructions} version={template.version} locked={locked} onSave={(instructions) => onChange({ instructions })} />

      <Row label="Working hours" labelId={ids.days} testId="workbot-proactive-hours">
        <div className="w-36">
          <DenSelect aria-label="Working days" menuWidth="trigger" value={settings.workingDays} disabled={locked}
            onChange={(event) => onChange({ workingDays: event.target.value === "everyday" ? "everyday" : "weekdays" })}>
            <option value="weekdays">Weekdays</option>
            <option value="everyday">Every day</option>
          </DenSelect>
        </div>
        <div className="w-28">
          <DenSelect aria-label="Start of the workday" menuWidth="trigger" value={String(settings.startHour)} disabled={locked}
            onChange={(event) => onChange({ startHour: Number(event.target.value) })}>
            {Array.from({ length: 24 }, (_, hour) => (
              <option key={hour} value={String(hour)} disabled={hour >= settings.endHour}>{hourLabel(hour)}</option>
            ))}
          </DenSelect>
        </div>
        <span className="text-[13px] text-gray-500">to</span>
        <div className="w-28">
          <DenSelect aria-label="End of the workday" menuWidth="trigger" value={String(settings.endHour)} disabled={locked}
            onChange={(event) => onChange({ endHour: Number(event.target.value) })}>
            {Array.from({ length: 24 }, (_, index) => index + 1).map((hour) => (
              <option key={hour} value={String(hour)} disabled={hour <= settings.startHour}>{hourLabel(hour)}</option>
            ))}
          </DenSelect>
        </div>
      </Row>

      <Row label="Daily limit" labelId={ids.cap} testId="workbot-proactive-cap">
        <div className="w-36">
          <DenSelect aria-labelledby={ids.cap} menuWidth="trigger" value={String(settings.dailyCap)} disabled={locked}
            onChange={(event) => {
              const cap = WORKBOT_PROACTIVE_DAILY_CAPS.find((value) => String(value) === event.target.value);
              if (cap) onChange({ dailyCap: cap });
            }}>
            {WORKBOT_PROACTIVE_DAILY_CAPS.map((cap) => (
              <option key={cap} value={String(cap)}>{`${cap} per person`}</option>
            ))}
          </DenSelect>
        </div>
      </Row>

      <Row label="Members start" labelId={ids.members} testId="workbot-proactive-members">
        <div className="w-36">
          <DenSelect aria-labelledby={ids.members} menuWidth="trigger" value={settings.membersStart} disabled={locked}
            onChange={(event) => onChange({ membersStart: event.target.value === "opted_out" ? "opted_out" : "opted_in" })}>
            <option value="opted_in">Opted in</option>
            <option value="opted_out">Must opt in</option>
          </DenSelect>
        </div>
      </Row>

      <div className="grid gap-3 px-6 py-4" data-testid="workbot-proactive-preview-row">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[13px] font-medium text-gray-900">Preview</span>
          <DenSegmented aria-label="Preview message" options={PROACTIVE_PREVIEW_KINDS} value={preview} onChange={setPreview}
            optionTestId={(kind) => `workbot-proactive-preview-${kind}`} />
        </div>
        <WorkbotProactivePreview kind={preview} leadMinutes={settings.leadMinutes} />
      </div>
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-100 bg-white" data-testid="workbot-proactive-skeleton">
      {["w-36", "w-32", "w-28", "w-28", "w-32", "w-28", "w-40", "w-32", "w-24", "w-28"].map((width, index) => (
        <div key={index} className="flex min-h-[66px] items-center justify-between gap-3 px-6 py-3">
          <DenSkeleton className={`h-4 ${width}`} />
          <DenSkeleton className="h-[42px] w-36" />
        </div>
      ))}
    </div>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function WorkbotProactiveSection({ orgId, canManage, connectorsHref, scope = EVERYONE, headerAside, belowHeader, busy = false, onEdit, show = "all" }: {
  /** With Workbot's settings in tabs: only how agents work ("policy"), or only what they read ("sources"). */
  show?: WorkbotAgentsPart;
  orgId: string;
  canManage: boolean;
  connectorsHref: string;
  /** Whose policy: Everyone's (the default), or one team's. */
  scope?: AgentPolicyScope;
  /** Beside the heading: where the policy comes from, and the way back to Everyone's. */
  headerAside?: ReactNode;
  /** Lines of state under the heading. */
  belowHeader?: ReactNode;
  /** Something else is saving this policy, so its controls wait. */
  busy?: boolean;
  /** A control was changed and its save started. */
  onEdit?: () => void;
}) {
  const query = useWorkbotProactive(orgId, Boolean(orgId), scope);
  const { orgSlug } = useOrgDashboard();
  const save = useSaveWorkbotProactive(orgId, scope);
  const headingId = useId();
  const saving = save.isPending || busy;
  const change = (next: WorkbotProactiveSettingsInput) => {
    onEdit?.();
    save.mutate(next);
  };
  const heading = <h2 id={headingId} className="px-1 text-[13px] font-medium text-gray-500">{show === "sources" ? "What agents read" : "Members' agents"}</h2>;

  return (
    <section aria-labelledby={headingId} className="grid gap-2" data-section="workbot-proactive">
      {headerAside ? (
        <div className="flex min-h-6 flex-wrap items-center justify-between gap-3 pr-1">
          {heading}
          <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">{headerAside}</div>
        </div>
      ) : heading}
      {belowHeader}
      {query.isError ? (
        <DenNotice
          tone="error"
          message={errorMessage(query.error, "Couldn't load agent settings.")}
          action={(
            <DenButton variant="secondary" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>
              Try again
            </DenButton>
          )}
        />
      ) : query.data ? (
        <div className="grid gap-6">
          {show === "sources" ? null : (
            <WorkbotProactivePanel
              view={query.data}
              canManage={canManage}
              saving={saving}
              connectorsHref={connectorsHref}
              onChange={change}
              scope={scope}
            />
          )}
          {show === "policy" ? null : (
            <WorkbotProactiveSources view={query.data} canManage={canManage} saving={saving} onChange={change} heading={show !== "sources"}
              tools={{ orgId, scope, connectorHref: (connectionId) => getLibraryConnectorRoute(orgSlug, connectionId) }} />
          )}
        </div>
      ) : (
        <PanelSkeleton />
      )}
      {save.isError ? (
        <p role="alert" className="px-1 text-[13px] text-red-700">{errorMessage(save.error, "Couldn't save. Try again.")}</p>
      ) : null}
    </section>
  );
}
