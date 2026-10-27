"use client";

import Link from "next/link";
import { Lock } from "lucide-react";
import { useEffect, useId, useState } from "react";
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
import { useSaveWorkbotProactive, useWorkbotProactive } from "./workbot-proactive-data";
import { PROACTIVE_PREVIEW_KINDS, WorkbotProactivePreview } from "./workbot-proactive-preview";

/**
 * Manage › Workbot › Your agent: every member gets a background agent that reads their Gmail and Google Calendar on
 * a schedule and messages them only when something needs them. One switch for the organization, what agents tell
 * people about, where messages go, when and how often, and a preview.
 */

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
}: {
  view: WorkbotProactiveView;
  canManage: boolean;
  saving: boolean;
  onChange: (change: WorkbotProactiveSettingsInput) => void;
  connectorsHref: string;
  initialPreview?: AgentResponsibility;
}) {
  const ids = { destination: useId(), days: useId(), cap: useId(), members: useId() };
  const [preview, setPreview] = useState<AgentResponsibility>(initialPreview);
  const { settings, template, slackReady, runnerReady } = view;
  const locked = !canManage || saving;
  const switchNote = !runnerReady
    ? "Needs OpenWork's headless runner. Ask your OpenWork operator to set it up."
    : !settings.destination
      ? "Choose where messages go first."
      : !slackReady
        ? "Needs the Slack app first."
        : null;

  return (
    <div className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-100 bg-white" data-testid="workbot-proactive-panel">
      <Row label="Agents for everyone" testId="workbot-proactive-enabled" note={switchNote}>
        <DenSwitch
          aria-label="Agents for everyone"
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

export function WorkbotProactiveSection({ orgId, canManage, connectorsHref }: { orgId: string; canManage: boolean; connectorsHref: string }) {
  const query = useWorkbotProactive(orgId, Boolean(orgId));
  const save = useSaveWorkbotProactive(orgId);
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="grid gap-2" data-section="workbot-proactive">
      <h2 id={headingId} className="px-1 text-[13px] font-medium text-gray-500">Members' agents</h2>
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
        <WorkbotProactivePanel
          view={query.data}
          canManage={canManage}
          saving={save.isPending}
          connectorsHref={connectorsHref}
          onChange={(change) => save.mutate(change)}
        />
      ) : (
        <PanelSkeleton />
      )}
      {save.isError ? (
        <p role="alert" className="px-1 text-[13px] text-red-700">{errorMessage(save.error, "Couldn't save. Try again.")}</p>
      ) : null}
    </section>
  );
}
