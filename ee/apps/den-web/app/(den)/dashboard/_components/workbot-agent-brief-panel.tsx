"use client";

import Link from "next/link";
import { Lock } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import {
  AGENT_BRIEF_DAILY_CAP_MAX,
  AGENT_BRIEF_MAX,
  AGENT_CHECK_EVERY_HOURS,
  AGENT_EXTRA_CHECKS_MAX,
  type AgentBriefView,
  type WorkbotProactiveSettingsInput,
  type WorkbotProactiveView,
} from "@openwork/types/den/workbot-proactive";
import { DenButton } from "../../_components/ui/button";
import { DenSelect } from "../../_components/ui/select";
import { DenSwitch } from "../../_components/ui/switch";
import { DenTextarea } from "../../_components/ui/textarea";
import { agentsSwitchLabel, type AgentPolicyScope } from "./workbot-agent-scope";

/**
 * Manage › Workbot › Members' agents with Your agent's brief (`workbotAgentBrief`): one rhythm ("Check every 2 hours,
 * 8 AM–7 PM, weekdays"), the daily limit, the extra checks agents may ask for, and what to tell people as one text
 * the agents read. Replaces the four message types, the meeting lead time and the organization instructions, which
 * are carried into the text until an admin saves it. Where messages go and what agents read stay as they are.
 * A team's Workbot tab shows the same rows for the team's policy (`scope`).
 */

export function hourLabel(hour: number) {
  const h = hour % 24;
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
}

export function everyLabel(hours: number) {
  return hours === 1 ? "Every hour" : `Every ${hours} hours`;
}

/** The send check's row (`workbotAgentSendCheck`), worded the same in both layouts. */
export const SEND_CHECK_ROW = {
  label: "Check each message before sending",
  help: "A second, fast model reads each message before it is sent and holds one your instructions say to leave out, or that repeats what the agent already said today. It never writes or changes a message, and it keeps nothing it reads.",
  notReady: "Not set up on this deployment. Ask your deployment administrator.",
} as const;

function Row({ label, labelId, note, children, testId }: { label: string; labelId?: string; note?: ReactNode; children: ReactNode; testId?: string }) {
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

/** What to tell people: the brief as one text, with Reset to default and Save, saved only on Save. */
export function BriefRow({ brief, locked, onSave }: { brief: AgentBriefView; locked: boolean; onSave: (text: string) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(brief.text);
  useEffect(() => setDraft(brief.text), [brief.text]);
  const changed = draft.trim() !== brief.text.trim();
  const isDefault = draft.trim() === brief.defaultText.trim();
  const carried = brief.carriedOver.includes("text") && !changed && !isDefault;
  return (
    <div className="grid gap-2 px-6 py-3" data-testid="workbot-agent-brief-text">
      <div className="flex min-h-[28px] items-center justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-medium text-gray-900">What to tell people</label>
        {!isDefault ? (
          <DenButton variant="ghost" size="xs" disabled={locked} onClick={() => setDraft(brief.defaultText)}>Reset to default</DenButton>
        ) : (
          <span className="text-[12px] text-gray-500">Default</span>
        )}
      </div>
      <DenTextarea id={id} rows={Math.min(14, Math.max(6, draft.split("\n").length + 1))} maxLength={AGENT_BRIEF_MAX} value={draft} disabled={locked}
        className="text-[13px] leading-5" onChange={(event) => setDraft(event.target.value)} />
      {carried ? <p className="text-[12px] text-gray-500" data-testid="workbot-agent-brief-carried">From your earlier settings.</p> : null}
      {changed ? (
        <div className="flex justify-end gap-2">
          <DenButton variant="secondary" size="sm" onClick={() => setDraft(brief.text)}>Discard</DenButton>
          <DenButton size="sm" disabled={locked || !draft.trim()} onClick={() => onSave(draft.trim())}>Save brief</DenButton>
        </div>
      ) : null}
    </div>
  );
}

/** A sample message in the brief's voice, as members get it in their Workbot DM. Fictional names; not interactive. */
export function BriefPreview() {
  return (
    <div className="flex gap-3 rounded-xl bg-gray-50 px-4 py-3 text-[13px] leading-5 text-gray-900" data-testid="workbot-agent-brief-preview">
      <img src="/openwork-mark.svg" alt="" className="mt-0.5 h-8 w-8 shrink-0 rounded-lg border border-gray-200 bg-white p-1.5" />
      <div className="grid min-w-0 gap-1">
        <p className="flex items-baseline gap-2">
          <span className="font-semibold">OpenWork</span>
          <span className="text-[12px] text-gray-500">1:45 PM</span>
        </p>
        <p>
          Before your 2 PM with Northwind Labs: Dana asked in Slack for the updated pricing sheet and is still waiting. I checked your sent mail and found nothing since Tuesday. Want me to draft a reply?{" "}
          <span className="font-medium underline underline-offset-2">Slack message</span>
        </p>
      </div>
    </div>
  );
}

export function WorkbotAgentBriefPanel({
  view,
  brief,
  canManage,
  saving,
  onChange,
  connectorsHref,
  scope = { kind: "everyone" },
}: {
  view: WorkbotProactiveView;
  brief: AgentBriefView;
  canManage: boolean;
  saving: boolean;
  onChange: (change: WorkbotProactiveSettingsInput) => void;
  connectorsHref: string;
  /** Whose policy the rows show: Everyone's, or one team's. */
  scope?: AgentPolicyScope;
}) {
  const ids = { destination: useId(), rhythm: useId(), cap: useId(), extra: useId(), members: useId() };
  const switchLabel = agentsSwitchLabel(scope);
  const { settings, slackReady, runnerReady } = view;
  const locked = !canManage || saving;
  const switchNote = !runnerReady
    ? "Needs the headless runner. Ask your deployment administrator."
    : !settings.destination
      ? "Choose where messages go first."
      : !slackReady
        ? "Needs the Slack app first."
        : null;

  return (
    <div className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-100 bg-white" data-testid="workbot-proactive-panel" data-mode="brief">
      <Row label={switchLabel} testId="workbot-proactive-enabled" note={switchNote}>
        <DenSwitch aria-label={switchLabel} checked={settings.enabled} disabled={locked || (Boolean(switchNote) && !settings.enabled)} onChange={(enabled) => onChange({ enabled })} />
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
          <DenSelect aria-labelledby={ids.destination} menuWidth="trigger" value={settings.destination ?? "none"} disabled={locked}
            onChange={(event) => onChange({ destination: event.target.value === "workbot_dm" ? "workbot_dm" : null })}>
            <option value="workbot_dm">A DM from Workbot</option>
            <option value="none">Nowhere yet</option>
          </DenSelect>
        </div>
      </Row>

      <Row label="Check" labelId={ids.rhythm} testId="workbot-agent-brief-rhythm">
        <div className="w-40">
          <DenSelect aria-label="How often agents check" menuWidth="trigger" value={String(brief.checkEveryHours)} disabled={locked}
            onChange={(event) => {
              const hours = AGENT_CHECK_EVERY_HOURS.find((value) => String(value) === event.target.value);
              if (hours) onChange({ brief: { checkEveryHours: hours } });
            }}>
            {AGENT_CHECK_EVERY_HOURS.map((hours) => <option key={hours} value={String(hours)}>{everyLabel(hours)}</option>)}
          </DenSelect>
        </div>
        <div className="w-28">
          <DenSelect aria-label="Start of the workday" menuWidth="trigger" value={String(settings.startHour)} disabled={locked}
            onChange={(event) => onChange({ startHour: Number(event.target.value) })}>
            {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={String(hour)} disabled={hour >= settings.endHour}>{hourLabel(hour)}</option>)}
          </DenSelect>
        </div>
        <span className="text-[13px] text-gray-500">to</span>
        <div className="w-28">
          <DenSelect aria-label="End of the workday" menuWidth="trigger" value={String(settings.endHour)} disabled={locked}
            onChange={(event) => onChange({ endHour: Number(event.target.value) })}>
            {Array.from({ length: 24 }, (_, index) => index + 1).map((hour) => <option key={hour} value={String(hour)} disabled={hour <= settings.startHour}>{hourLabel(hour)}</option>)}
          </DenSelect>
        </div>
        <div className="w-32">
          <DenSelect aria-label="Working days" menuWidth="trigger" value={settings.workingDays} disabled={locked}
            onChange={(event) => onChange({ workingDays: event.target.value === "everyday" ? "everyday" : "weekdays" })}>
            <option value="weekdays">Weekdays</option>
            <option value="everyday">Every day</option>
          </DenSelect>
        </div>
      </Row>

      <Row label="Messages per person per day" labelId={ids.cap} testId="workbot-agent-brief-cap">
        <div className="w-28">
          <DenSelect aria-labelledby={ids.cap} menuWidth="trigger" value={String(brief.dailyCap)} disabled={locked}
            onChange={(event) => onChange({ brief: { dailyCap: Number(event.target.value) } })}>
            {Array.from({ length: AGENT_BRIEF_DAILY_CAP_MAX }, (_, index) => index + 1).map((cap) => <option key={cap} value={String(cap)}>{String(cap)}</option>)}
          </DenSelect>
        </div>
      </Row>

      {view.sendCheck ? (
        <Row label={SEND_CHECK_ROW.label} testId="workbot-agent-send-check" note={view.sendCheck.ready ? null : SEND_CHECK_ROW.notReady}>
          <DenSwitch aria-label={SEND_CHECK_ROW.label} checked={settings.sendCheck === true} disabled={locked || (!view.sendCheck.ready && settings.sendCheck !== true)}
            onChange={(sendCheck) => onChange({ sendCheck })} />
        </Row>
      ) : null}

      <Row label="Extra checks agents may ask for" labelId={ids.extra} testId="workbot-agent-brief-extra">
        <div className="w-36">
          <DenSelect aria-labelledby={ids.extra} menuWidth="trigger" value={String(brief.extraChecksPerDay)} disabled={locked}
            onChange={(event) => onChange({ brief: { extraChecksPerDay: Number(event.target.value) } })}>
            {Array.from({ length: AGENT_EXTRA_CHECKS_MAX + 1 }, (_, count) => <option key={count} value={String(count)}>{count === 0 ? "None" : `${count} a day`}</option>)}
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

      <BriefRow brief={brief} locked={locked} onSave={(text) => onChange({ brief: { text } })} />

      <div className="grid gap-3 px-6 py-4" data-testid="workbot-proactive-preview-row">
        <span className="text-[13px] font-medium text-gray-900">Preview</span>
        <BriefPreview />
      </div>
    </div>
  );
}
