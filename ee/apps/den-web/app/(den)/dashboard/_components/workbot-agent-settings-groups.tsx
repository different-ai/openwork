"use client";

import Link from "next/link";
import { Info, Lock } from "lucide-react";
import { useId, type ReactNode } from "react";
import {
  AGENT_BRIEF_DAILY_CAP_MAX,
  AGENT_CHECK_EVERY_HOURS,
  AGENT_EXTRA_CHECKS_MAX,
  type AgentBriefView,
  type WorkbotProactiveSettingsInput,
  type WorkbotProactiveView,
} from "@openwork/types/den/workbot-proactive";
import { DenSelect } from "../../_components/ui/select";
import { DenSwitch } from "../../_components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../_components/ui/tooltip";
import { BriefPreview, BriefRow, everyLabel, hourLabel } from "./workbot-agent-brief-panel";
import { agentsSwitchLabel, type AgentPolicyScope } from "./workbot-agent-scope";

/**
 * Members' agents with `workbotSettingsTabs` on: the same settings and saves as `WorkbotAgentBriefPanel`, in three
 * groups (who gets an agent, messages, schedule) and then what to tell people. A choice between yes and no is a
 * switch, a choice among several is a select, and every row says what it does in a tooltip beside its label.
 */

/** What each row does, shown from the "i" beside its label. */
export const AGENT_SETTING_HELP = {
  membersStart: "On: members get messages and can turn their agent off. Off: each member turns their agent on.",
  slack: "Each member gets a direct message in Slack from Workbot. Agents can't be turned on without it.",
  dailyCap: "The most messages an agent sends one member in a day. A member can only lower it.",
  checkEvery: "How often each member's agent reads their calendar, email, team chat and other context for things to tell them. A member can only check less often.",
  hours: "Agents check and send messages only between these hours, in each member's calendar time zone.",
  days: "The days agents check and send messages.",
  extraChecks: "Besides the schedule, an agent may ask for this many more checks a day, for example at 1:45 before a 2 PM meeting.",
} as const;

function HelpTip({ label, children }: { label: string; children: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" />}
        aria-label={`About ${label}`}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-gray-500 outline-hidden hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-gray-400"
      >
        <Info size={14} strokeWidth={1.5} aria-hidden="true" />
        <span className="sr-only">{`: ${children}`}</span>
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  );
}

function Row({ label, labelId, help, note, children, testId }: { label: string; labelId?: string; help?: string; note?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div className="px-6 py-3" data-testid={testId}>
      <div className="flex min-h-[42px] flex-wrap items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1.5">
          <span id={labelId} className="text-[13px] font-medium text-gray-900">{label}</span>
          {help ? <HelpTip label={label}>{help}</HelpTip> : null}
        </span>
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

function Group({ title, children }: { title?: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={title ? headingId : undefined} className="grid gap-2">
      {title ? <h3 id={headingId} className="px-1 text-[13px] font-medium text-gray-500">{title}</h3> : null}
      <div className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-100 bg-white">{children}</div>
    </section>
  );
}

export function WorkbotAgentSettingsGroups({ view, brief, canManage, saving, onChange, connectorsHref, scope = { kind: "everyone" } }: {
  view: WorkbotProactiveView;
  brief: AgentBriefView;
  canManage: boolean;
  saving: boolean;
  onChange: (change: WorkbotProactiveSettingsInput) => void;
  connectorsHref: string;
  /** Whose policy the rows show: Everyone's, or one team's. */
  scope?: AgentPolicyScope;
}) {
  const ids = { every: useId(), hours: useId(), days: useId(), cap: useId(), extra: useId() };
  const switchLabel = agentsSwitchLabel(scope);
  const { settings, slackReady, runnerReady } = view;
  const locked = !canManage || saving;
  const switchNote = !runnerReady
    ? "Needs the headless runner. Ask your deployment administrator."
    : !settings.destination
      ? "Turn on Send messages in Slack first."
      : !slackReady
        ? "Needs the Slack app first."
        : null;

  return (
    <div className="grid gap-5" data-testid="workbot-proactive-panel" data-mode="brief" data-layout="groups">
      <Group>
        <Row label={switchLabel} testId="workbot-proactive-enabled" note={switchNote}>
          <DenSwitch aria-label={switchLabel} checked={settings.enabled} disabled={locked || (Boolean(switchNote) && !settings.enabled)} onChange={(enabled) => onChange({ enabled })} />
        </Row>
        <Row label="On for members by default" help={AGENT_SETTING_HELP.membersStart} testId="workbot-proactive-members">
          <DenSwitch aria-label="On for members by default" checked={settings.membersStart === "opted_in"} disabled={locked}
            onChange={(on) => onChange({ membersStart: on ? "opted_in" : "opted_out" })} />
        </Row>
      </Group>

      <Group title="Messages">
        <Row
          label="Send messages in Slack"
          help={AGENT_SETTING_HELP.slack}
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
          <DenSwitch aria-label="Send messages in Slack" checked={settings.destination === "workbot_dm"} disabled={locked}
            onChange={(on) => onChange({ destination: on ? "workbot_dm" : null })} />
        </Row>
        <Row label="Daily message limit" labelId={ids.cap} help={AGENT_SETTING_HELP.dailyCap} testId="workbot-agent-brief-cap">
          <div className="w-36">
            <DenSelect aria-labelledby={ids.cap} menuWidth="trigger" value={String(brief.dailyCap)} disabled={locked}
              onChange={(event) => onChange({ brief: { dailyCap: Number(event.target.value) } })}>
              {Array.from({ length: AGENT_BRIEF_DAILY_CAP_MAX }, (_, index) => index + 1).map((cap) => <option key={cap} value={String(cap)}>{`${cap} a day`}</option>)}
            </DenSelect>
          </div>
        </Row>
      </Group>

      <Group title="Schedule">
        <Row label="Check for updates" labelId={ids.every} help={AGENT_SETTING_HELP.checkEvery} testId="workbot-agent-brief-rhythm">
          <div className="w-40">
            <DenSelect aria-labelledby={ids.every} menuWidth="trigger" value={String(brief.checkEveryHours)} disabled={locked}
              onChange={(event) => {
                const hours = AGENT_CHECK_EVERY_HOURS.find((value) => String(value) === event.target.value);
                if (hours) onChange({ brief: { checkEveryHours: hours } });
              }}>
              {AGENT_CHECK_EVERY_HOURS.map((hours) => <option key={hours} value={String(hours)}>{everyLabel(hours)}</option>)}
            </DenSelect>
          </div>
        </Row>
        <Row label="Working hours" labelId={ids.hours} help={AGENT_SETTING_HELP.hours} testId="workbot-agent-brief-hours">
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
        </Row>
        <Row label="Working days" labelId={ids.days} help={AGENT_SETTING_HELP.days} testId="workbot-agent-brief-days">
          <div className="w-36">
            <DenSelect aria-labelledby={ids.days} menuWidth="trigger" value={settings.workingDays} disabled={locked}
              onChange={(event) => onChange({ workingDays: event.target.value === "everyday" ? "everyday" : "weekdays" })}>
              <option value="weekdays">Weekdays</option>
              <option value="everyday">Every day</option>
            </DenSelect>
          </div>
        </Row>
        <Row label="Extra checks" labelId={ids.extra} help={AGENT_SETTING_HELP.extraChecks} testId="workbot-agent-brief-extra">
          <div className="w-36">
            <DenSelect aria-labelledby={ids.extra} menuWidth="trigger" value={String(brief.extraChecksPerDay)} disabled={locked}
              onChange={(event) => onChange({ brief: { extraChecksPerDay: Number(event.target.value) } })}>
              {Array.from({ length: AGENT_EXTRA_CHECKS_MAX + 1 }, (_, count) => <option key={count} value={String(count)}>{count === 0 ? "None" : `${count} a day`}</option>)}
            </DenSelect>
          </div>
        </Row>
      </Group>

      <Group>
        <BriefRow brief={brief} locked={locked} onSave={(text) => onChange({ brief: { text } })} />
        <div className="grid gap-3 px-6 py-4" data-testid="workbot-proactive-preview-row">
          <span className="text-[13px] font-medium text-gray-900">Preview</span>
          <BriefPreview />
        </div>
      </Group>
    </div>
  );
}
