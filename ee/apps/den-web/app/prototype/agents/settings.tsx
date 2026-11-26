"use client";

import { ChevronRight, Copy, Plus } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { DenButton } from "../../(den)/_components/ui/button";
import { COMPACT_INPUT_CLASS } from "../../(den)/_components/ui/dashboard-styles";
import { DenInput } from "../../(den)/_components/ui/input";
import { DenSegmented, type DenSegmentedOption } from "../../(den)/_components/ui/segmented";
import { DenSelect } from "../../(den)/_components/ui/select";
import { DenSwitch } from "../../(den)/_components/ui/switch";
import { DenTextarea } from "../../(den)/_components/ui/textarea";
import { DenUsageMeter } from "../../(den)/_components/ui/usage-meter";
import { ItemSection } from "../../(den)/dashboard/_components/item-list";
import { ConnectorLogo } from "../../(den)/dashboard/_components/item-logo";
import { hourLabel } from "../../(den)/dashboard/_components/my-agent-view";
import { formatWorkbotCost } from "../../(den)/dashboard/_features/workbot-usage/workbot-usage-data";
import {
  type Access,
  type Agent,
  type AgentColor,
  type ConnectorId,
  type PaidBy,
  type Preset,
  type Routine,
  type Schedule,
  type ToolSet,
  AGENT_COLORS,
  BUDGET_DOLLARS,
  CONNECTORS,
  DEFAULT_SCHEDULE,
  DOLLAR,
  ME,
  MEMBER,
  MODELS,
  MY_COMPUTERS,
  OPENWORK_AREAS,
  PRESET_LABEL,
  RHYTHMS,
  ROLE_LABEL,
  WEEKDAYS,
  agentCode,
  agentFile,
  agentFilePath,
  budgetLine,
  effectiveBudget,
  effectiveTools,
  firstNameOf,
  initialsOf,
  isMine,
  isShared,
  isWriteTool,
  keepRoutineState,
  listWords,
  makeRoutine,
  nextRunLine,
  nextRunText,
  orgBudgetSpent,
  overBudget,
  paidByLine,
  personName,
  presetOf,
  readAgentCode,
  readAgentFile,
  recipientStatus,
  roleOf,
  routineName,
  routineWhen,
  routinesLine,
  shareCaution,
  shareEffect,
  shareLabel,
  sharedPeople,
  toolCount,
  toolLabel,
  toolsForLevel,
  toolsLine,
  uniqueRoutineName,
  usedByMe,
} from "./model";
import { LockNote, Row, adminBlockNote, spendMeter } from "./parts";

// ---------------------------------------------------------------------------
// An agent's settings, shown inside the OpenWork app next to its thread.
// Everything is laid out for a narrow column.
// ---------------------------------------------------------------------------

function Status({ title, sentence, children, state }: { title: string; sentence: string; children: ReactNode; state: string }) {
  return (
    <div className="flex items-start justify-between gap-4" data-testid="agent-status" data-state={state}>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[15px] font-semibold leading-5 tracking-[-0.2px] text-gray-950">{title}</span>
        <span className="text-[13px] leading-5 text-gray-600">{sentence}</span>
      </div>
      <span className="pt-0.5">{children}</span>
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 py-2.5">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-gray-900">{label}</label>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// An agent you can change: your own, or one you are a manager of
// ---------------------------------------------------------------------------

export function AgentSettings({ agent, access, connected, running, onPatch, onRemove, onLeave, onConnect, onOpenShare, onStopSharing, onRun }: {
  agent: Agent;
  access: Access;
  connected: Record<ConnectorId, boolean>;
  running: boolean;
  onPatch: (patch: Partial<Agent>) => void;
  onRemove: () => void;
  onLeave: () => void;
  onConnect: (id: ConnectorId) => void;
  onOpenShare: () => void;
  onStopSharing: () => void;
  onRun: (routineId: string) => void;
}) {
  const ids = { name: useId(), instructions: useId() };
  const [name, setName] = useState(agent.name);
  const [instructions, setInstructions] = useState(agent.instructions);
  useEffect(() => setName(agent.name), [agent.name]);
  useEffect(() => setInstructions(agent.instructions), [agent.instructions]);

  const mine = isMine(agent);
  const draft = agent.setup !== null;
  const budget = effectiveBudget(agent, access);
  const over = overBudget(agent, access);
  const nameChanged = name.trim() !== agent.name && name.trim().length > 0;
  const instructionsChanged = instructions.trim() !== agent.instructions.trim();
  const setUp = agent.instructions.trim().length > 0;
  const shared = isShared(agent.share, agent.owner);
  const title = draft ? "Not started yet" : !setUp ? "Not set up yet" : !mine ? "Run its routines for me" : !agent.on ? "Paused" : over ? "Over budget" : "On";
  const sentence = draft
    ? "Only you can see it. Tell it its job in the chat and it starts."
    : !setUp
      ? "Tell it what to do, choose what it can use, then turn it on."
      : !agent.on
        ? mine ? "It keeps its instructions and history, and runs nothing." : "Off for you. You can still ask it things in its conversation."
        : over
          ? `It used ${formatWorkbotCost(agent.spentMicro)} of ${formatWorkbotCost(budget ?? 0)}. It runs again next month, or when its budget is raised.`
          : `${nextRunText(agent)}. ${budget === null ? budgetLine(agent, access) : `${budgetLine(agent, access)} this month`}.`;

  return (
    <div className="flex flex-col gap-6" data-testid="agent-settings" data-owner={mine ? "me" : agent.owner} data-role={roleOf(agent) ?? "none"}>
      <div className="flex flex-col gap-2">
        <Status title={title} sentence={sentence} state={draft ? "draft" : !agent.on ? "paused" : over ? "over_budget" : "on"}>
          <DenSwitch aria-label={mine ? agent.name : `Run ${agent.name}'s routines for you`} checked={agent.on} disabled={draft} onChange={(on) => onPatch({ on })} testId="agent-on" />
        </Status>
        {mine ? null : (
          <LockNote>{`${personName(agent.owner)} owns it and made you a manager. What you change here changes it for everyone who uses it.`}</LockNote>
        )}
      </div>

      <ItemSection title="What it does" variant="rule" testId="agent-instructions">
        <div className="flex flex-col divide-y divide-gray-100">
          <Field label="Name" htmlFor={ids.name}>
            <div className="flex items-center gap-2">
              <DenInput id={ids.name} value={name} maxLength={40} className={COMPACT_INPUT_CLASS} onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && nameChanged) onPatch({ name: name.trim() }); }} data-testid="agent-name" />
              {nameChanged ? <DenButton size="xs" onClick={() => onPatch({ name: name.trim() })}>Save</DenButton> : null}
            </div>
          </Field>
          <Row label="Colour">
            <ColorPicker color={agent.color} onChange={(color) => onPatch({ color })} />
          </Row>
          <Field label="Instructions" htmlFor={ids.instructions}>
            <DenTextarea id={ids.instructions} rows={4} value={instructions} maxLength={2000} className="resize-none [field-sizing:content]"
              placeholder={"Read my open issues and review requests.\nTell me what needs me today, most urgent first."}
              onChange={(event) => setInstructions(event.target.value)} data-testid="agent-instructions-input" />
            {instructionsChanged ? (
              <span className="flex justify-end gap-2">
                <DenButton variant="secondary" size="xs" onClick={() => setInstructions(agent.instructions)}>Discard</DenButton>
                <DenButton size="xs" onClick={() => onPatch({ instructions: instructions.trim() })} data-testid="agent-instructions-save">Save</DenButton>
              </span>
            ) : null}
          </Field>
        </div>
      </ItemSection>

      <RoutinesSection agent={agent} running={running} onPatch={onPatch} onRun={onRun} />

      <ItemSection title="What it can use" variant="rule" testId="agent-connectors" meta="Each tool is allowed or blocked">
        <div className="flex flex-col divide-y divide-gray-100">
          {CONNECTORS.map((connector) => (
            <ConnectorAccessRow
              key={connector.id}
              connector={connector}
              tools={agent.tools[connector.id]}
              blocked={access.blocked[connector.id]}
              connected={connected[connector.id]}
              onTools={(tools) => onPatch({ tools: { ...agent.tools, [connector.id]: tools } })}
              onConnect={() => onConnect(connector.id)}
            />
          ))}
        </div>
      </ItemSection>

      <OpenWorkSection agent={agent} onPatch={onPatch} />

      <ItemSection title="Where it reports" variant="rule" testId="agent-delivery">
        <div className="flex flex-col divide-y divide-gray-100">
          <Row label="Its conversation in OpenWork">
            <span className="text-[12px] text-gray-500">{shared ? "Each person has their own" : "Always"}</span>
          </Row>
          <Row label="Also message me in Slack">
            <DenSwitch size="sm" aria-label="Also message me in Slack" checked={agent.alsoSlack} onChange={(alsoSlack) => onPatch({ alsoSlack })} />
          </Row>
          <Row label="Stay quiet when nothing is new">
            <DenSwitch size="sm" aria-label="Stay quiet when nothing is new" checked={agent.quietWhenNothing} onChange={(quietWhenNothing) => onPatch({ quietWhenNothing })} />
          </Row>
        </div>
      </ItemSection>

      <WhereSection agent={agent} access={access} onPatch={onPatch} />

      <SharingSection agent={agent} access={access} onOpenShare={onOpenShare} onStopSharing={onStopSharing} />

      <ItemSection title="Model and budget" variant="rule" testId="agent-budget">
        <div className="flex flex-col divide-y divide-gray-100">
          <Row label="Model">
            <div className="w-48">
              <DenSelect size="sm" aria-label="Model" menuWidth="trigger" value={agent.model}
                onChange={(event) => { const next = MODELS.find((model) => model.id === event.target.value); if (next) onPatch({ model: next.id }); }}>
                {MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
              </DenSelect>
            </div>
          </Row>
          <BudgetRows agent={agent} access={access} onBudget={(budgetMicro) => onPatch({ budgetMicro })} onPaidBy={(paidBy) => onPatch({ paidBy })} />
        </div>
      </ItemSection>

      <AgentFileSection
        agent={agent}
        access={access}
        onApply={(patch) => onPatch(patch.routines ? { ...patch, routines: keepRoutineState(patch.routines, agent.routines) } : patch)}
      />

      <div className="flex justify-end pb-2">
        {mine ? (
          <DenButton variant="destructive" size="sm" onClick={onRemove} data-testid="agent-remove">{draft ? "Delete draft" : "Remove agent"}</DenButton>
        ) : (
          <DenButton variant="secondary" size="sm" onClick={onLeave} data-testid="agent-leave">Remove from my list</DenButton>
        )}
      </div>
    </div>
  );
}

// An agent's colour is picked for it when it is made. It can be changed here.
function ColorPicker({ color, onChange }: { color: AgentColor; onChange: (color: AgentColor) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Colour" data-testid="agent-color">
      {AGENT_COLORS.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="radio"
          aria-checked={color === entry.id}
          aria-label={entry.id}
          onClick={() => onChange(entry.id)}
          data-testid={`agent-color-${entry.id}`}
          className={`size-5 rounded-full transition-shadow ${color === entry.id ? "ring-2 ring-gray-900 ring-offset-2" : ""}`}
          style={{ backgroundColor: entry.fill }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Routines: each one is something the agent does on its own schedule
// ---------------------------------------------------------------------------

function nextRoutineId(agent: Agent): string {
  let count = agent.routines.length + 1;
  while (agent.routines.some((routine) => routine.id === `${agent.id}-routine-${count}`)) count += 1;
  return `${agent.id}-routine-${count}`;
}

function RoutinesSection({ agent, running, onPatch, onRun }: {
  agent: Agent;
  running: boolean;
  onPatch: (patch: Partial<Agent>) => void;
  onRun: (routineId: string) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const change = (id: string, patch: Partial<Routine>) => onPatch({ routines: agent.routines.map((routine) => routine.id === id ? { ...routine, ...patch } : routine) });
  const add = () => {
    const routine = makeRoutine(nextRoutineId(agent), uniqueRoutineName(routineName(DEFAULT_SCHEDULE), agent.routines), "", { ...DEFAULT_SCHEDULE });
    onPatch({ routines: [...agent.routines, routine] });
    setOpenId(routine.id);
  };
  return (
    <ItemSection title="Routines" variant="rule" testId="agent-routines" meta={routinesLine(agent)}>
      <div className="flex flex-col divide-y divide-gray-100">
        {agent.routines.length === 0 ? (
          <p className="py-3 text-[13px] leading-5 text-gray-500" data-testid="agent-routines-empty">No routines, so it works only when someone asks it in its conversation.</p>
        ) : null}
        {agent.routines.map((routine) => (
          <RoutineRow
            key={routine.id}
            routine={routine}
            others={agent.routines.filter((entry) => entry.id !== routine.id)}
            open={openId === routine.id}
            running={running}
            onOpen={() => setOpenId(openId === routine.id ? null : routine.id)}
            onChange={(patch) => change(routine.id, patch)}
            onTest={() => onRun(routine.id)}
            onDelete={() => { onPatch({ routines: agent.routines.filter((entry) => entry.id !== routine.id) }); setOpenId(null); }}
          />
        ))}
        <div className="flex items-center justify-between gap-3 py-2.5">
          <span className="min-w-0 flex-1 text-[12px] leading-4 text-gray-500">Each routine is one thing it does on a schedule. A new one waits for its next time.</span>
          <DenButton variant="secondary" size="xs" icon={Plus} onClick={add} data-testid="agent-routine-add">Add routine</DenButton>
        </div>
      </div>
    </ItemSection>
  );
}

function RoutineRow({ routine, others, open, running, onOpen, onChange, onTest, onDelete }: {
  routine: Routine;
  others: Routine[];
  open: boolean;
  running: boolean;
  onOpen: () => void;
  onChange: (patch: Partial<Routine>) => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  const ids = { name: useId(), instruction: useId() };
  const [name, setName] = useState(routine.name);
  const [instruction, setInstruction] = useState(routine.instruction);
  useEffect(() => setName(routine.name), [routine.name]);
  useEffect(() => setInstruction(routine.instruction), [routine.instruction]);
  const saveName = () => {
    const next = name.trim();
    if (next.length === 0) setName(routine.name);
    else if (next !== routine.name) onChange({ name: uniqueRoutineName(next, others) });
  };
  const saveInstruction = () => {
    if (instruction.trim() !== routine.instruction) onChange({ instruction: instruction.trim() });
  };
  return (
    <div className="flex flex-col" data-testid={`agent-routine-${routine.id}`} data-on={routine.on ? "true" : "false"}>
      <div className="flex min-h-[48px] items-center justify-between gap-3 py-2">
        <button type="button" onClick={onOpen} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left" data-testid={`agent-routine-open-${routine.id}`}>
          <ChevronRight className={`h-4 w-4 shrink-0 text-gray-500 transition-transform duration-150 ease-out motion-reduce:transition-none ${open ? "rotate-90" : ""}`} aria-hidden />
          <span className="flex min-w-0 flex-col">
            <span className={`truncate text-[13px] font-medium ${routine.on ? "text-gray-900" : "text-gray-500"}`} data-testid="agent-routine-name">{routine.name}</span>
            <span className="truncate text-[12px] leading-4 text-gray-500" data-testid="agent-routine-when">{routineWhen(routine)}</span>
          </span>
        </button>
        <DenSwitch size="sm" aria-label={`${routine.name} routine`} checked={routine.on} onChange={(on) => onChange({ on })} testId={`agent-routine-on-${routine.id}`} />
      </div>
      {open ? (
        <div className="flex flex-col pb-3 pl-6" data-testid={`agent-routine-editor-${routine.id}`}>
          <Field label="Name" htmlFor={ids.name}>
            <DenInput id={ids.name} value={name} maxLength={40} className={COMPACT_INPUT_CLASS} onChange={(event) => setName(event.target.value)} onBlur={saveName}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} data-testid={`agent-routine-name-${routine.id}`} />
          </Field>
          <Field label="What to do" htmlFor={ids.instruction}>
            <DenTextarea id={ids.instruction} rows={2} value={instruction} maxLength={600} className="resize-none [field-sizing:content]"
              placeholder="Leave empty and it follows the agent's instructions."
              onChange={(event) => setInstruction(event.target.value)} onBlur={saveInstruction} data-testid={`agent-routine-instruction-${routine.id}`} />
          </Field>
          <ScheduleEditor schedule={routine.schedule} onChange={(schedule) => onChange({ schedule })} />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-3">
            <span className="min-w-0 flex-1 text-[12px] leading-4 text-gray-500">{routine.on ? `${nextRunLine(routine.schedule)}. Test runs it once now.` : "Paused. It keeps its settings and runs nothing."}</span>
            <span className="flex shrink-0 gap-2">
              <DenButton variant="secondary" size="xs" disabled={running} onClick={onTest} data-testid={`agent-routine-test-${routine.id}`}>Test</DenButton>
              <DenButton variant="secondary" size="xs" onClick={onDelete} data-testid={`agent-routine-delete-${routine.id}`}>Delete</DenButton>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// When a routine runs.
function ScheduleEditor({ schedule, onChange }: { schedule: Schedule; onChange: (schedule: Schedule) => void }) {
  const set = (patch: Partial<Schedule>) => onChange({ ...schedule, ...patch });
  const hourly = schedule.rhythm !== "daily" && schedule.rhythm !== "weekly";
  return (
    <div className="flex flex-col divide-y divide-gray-100" data-testid="schedule-editor">
      <Row label="How often">
        <div className="w-40">
          <DenSelect size="sm" aria-label="How often it runs" menuWidth="trigger" value={schedule.rhythm}
            onChange={(event) => { const next = RHYTHMS.find((entry) => entry.id === event.target.value); if (next) set({ rhythm: next.id }); }}>
            {RHYTHMS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </DenSelect>
        </div>
      </Row>
      {hourly ? (
        <Row label="Hours">
          <HourSelect label="First run of the day" value={schedule.startHour} from={5} to={schedule.endHour - 1} onChange={(startHour) => set({ startHour })} />
          <span className="text-[13px] text-gray-500">to</span>
          <HourSelect label="Last run of the day" value={schedule.endHour} from={schedule.startHour + 1} to={22} onChange={(endHour) => set({ endHour })} />
        </Row>
      ) : (
        <Row label="At">
          {schedule.rhythm === "weekly" ? (
            <div className="w-36">
              <DenSelect size="sm" aria-label="Day of the week" menuWidth="trigger" value={schedule.weekday} onChange={(event) => set({ weekday: event.target.value })}>
                {WEEKDAYS.map((day) => <option key={day} value={day}>{day}</option>)}
              </DenSelect>
            </div>
          ) : null}
          <HourSelect label="Time of day" value={schedule.hour} from={5} to={22} onChange={(hour) => set({ hour })} />
        </Row>
      )}
      {schedule.rhythm !== "weekly" ? (
        <Row label="Days">
          <DenSegmented aria-label="Days it runs" value={schedule.days} onChange={(days) => set({ days })}
            options={[{ value: "weekdays", label: "Weekdays" }, { value: "everyday", label: "Every day" }]} />
        </Row>
      ) : null}
    </div>
  );
}

// Who has access, at a glance. The owner changes it in the share dialog.
function SharingSection({ agent, access, onOpenShare, onStopSharing }: {
  agent: Agent;
  access: Access;
  onOpenShare: () => void;
  onStopSharing: () => void;
}) {
  const mine = isMine(agent);
  const ownerFirst = firstNameOf(agent.owner);
  const shared = isShared(agent.share, agent.owner);
  const recipients = sharedPeople(agent.share, agent.owner);
  return (
    <ItemSection title="Who has access" variant="rule" testId="agent-sharing" meta={shared ? shareLabel(agent) : "Only you"}>
      <div className="flex flex-col divide-y divide-gray-100">
        <div className="flex flex-col gap-2 py-2.5">
          {mine ? (
            <span className="flex flex-col gap-1 text-[13px] leading-5 text-gray-700" data-testid="agent-share-effect">
              <span>{shareEffect(agent.share, agent.owner)}</span>
              {shared ? <span className="text-[12px] leading-4 text-gray-500">{shareCaution(agent)}</span> : null}
            </span>
          ) : (
            <span className="text-[13px] leading-5 text-gray-700" data-testid="agent-share-effect">
              {`${personName(agent.owner)} owns it. Everyone it is shared with uses their own accounts and never sees anyone else's runs.`}
            </span>
          )}
          {mine && (access.sharing || shared) ? (
            <span className="flex items-center gap-2">
              <DenButton variant="secondary" size="xs" disabled={!access.sharing} onClick={onOpenShare} data-testid="agent-share-change">{shared ? "Manage access" : "Share"}</DenButton>
              {shared ? <DenButton variant="secondary" size="xs" onClick={onStopSharing} data-testid="agent-stop-sharing">Stop sharing</DenButton> : null}
            </span>
          ) : null}
          {mine && !access.sharing ? (
            <LockNote>{shared ? "Your admin turned off sharing agents. Nobody else can use it until sharing is back on." : "Your admin turned off sharing agents."}</LockNote>
          ) : null}
          {mine ? null : <LockNote>{`Only ${ownerFirst} can change who has access.`}</LockNote>}
        </div>
        {recipients.map((person) => {
          const role = roleOf(agent, person) ?? "collaborator";
          return (
            <div key={person} className="flex min-h-[44px] items-center justify-between gap-3 py-2" data-testid={`agent-recipient-${person}`} data-role={role}>
              <span className="flex min-w-0 items-center gap-3">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gray-100 text-[11px] font-medium text-gray-700">{initialsOf(personName(person))}</span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-medium text-gray-900">{person === ME ? `${personName(person)} (you)` : personName(person)}</span>
                  <span className="text-[12px] leading-4 text-gray-500">{ROLE_LABEL[role]}</span>
                </span>
              </span>
              {mine ? <span className="text-right text-[12px] leading-4 text-gray-500">{recipientStatus(agent, person)}</span> : null}
            </div>
          );
        })}
      </div>
    </ItemSection>
  );
}

// Who pays and how much. A new agent is paid from its owner's own limit; nobody is asked while it is being made.
function BudgetRows({ agent, access, onBudget, onPaidBy }: {
  agent: Agent;
  access: Access;
  onBudget: (budgetMicro: number | null) => void;
  onPaidBy: (paidBy: PaidBy) => void;
}) {
  const budget = effectiveBudget(agent, access);
  const shared = isShared(agent.share, agent.owner);
  const payers: DenSegmentedOption<PaidBy>[] = [
    { value: "me", label: "My limit" },
    { value: "org", label: "Org budget", disabled: !access.orgBudget.offered },
  ];
  return (
    <>
      <Row label="Paid from" testId="agent-paid-by"
        note={access.orgBudget.offered
          ? <span className="text-[12px] leading-4 text-gray-500">{agent.paidBy === "org" ? `The org's agent budget pays${shared ? " for everyone who uses it" : ""}. It doesn't count toward your limit.` : shared ? "Each person's use counts toward their own limit." : "Its runs count toward your own monthly limit."}</span>
          : <LockNote>Your admin hasn't set up an org budget for agents.</LockNote>}>
        <DenSegmented aria-label="Who pays for this agent" value={agent.paidBy} onChange={onPaidBy} options={payers} optionTestId={(value) => `agent-paid-by-${value}`} />
      </Row>
      <Row label="Monthly budget" testId="agent-budget-row"
        note={access.agentCapMicro !== null ? <LockNote>{`Your admin allows up to ${formatWorkbotCost(access.agentCapMicro)} a month for each agent.`}</LockNote> : null}>
        <div className="w-48">
          <DenSelect size="sm" aria-label="Monthly budget" menuWidth="trigger" value={budget === null ? "none" : String(budget / DOLLAR)}
            onChange={(event) => onBudget(event.target.value === "none" ? null : Number(event.target.value) * DOLLAR)}>
            {BUDGET_DOLLARS.map((dollars) => (
              <option key={dollars} value={String(dollars)} disabled={access.agentCapMicro !== null && dollars * DOLLAR > access.agentCapMicro}>{`${formatWorkbotCost(dollars * DOLLAR)} a month`}</option>
            ))}
            <option value="none" disabled={access.agentCapMicro !== null}>No budget of its own</option>
          </DenSelect>
        </div>
      </Row>
      <SpendThisMonth agent={agent} access={access} caption={shared ? "Your own use. Each person it works for gets the same budget." : undefined} />
    </>
  );
}

function SpendThisMonth({ agent, access, caption }: { agent: Agent; access: Access; caption?: string }) {
  const budget = effectiveBudget(agent, access);
  return (
    <div className="py-4" data-testid="agent-spend">
      {budget === null ? (
        <p className="text-[13px] text-gray-700">{`${formatWorkbotCost(agent.spentMicro)} spent this month.`}</p>
      ) : (
        <DenUsageMeter
          label="This month"
          {...spendMeter(agent.spentMicro, budget)}
          readout={`${formatWorkbotCost(agent.spentMicro)} of ${formatWorkbotCost(budget)}`}
          caption={caption}
        />
      )}
    </div>
  );
}

// The agent as one file: the same settings, in a form that can live in a repo.
function AgentFileSection({ agent, access, onApply }: { agent: Agent; access: Access; onApply: (patch: Partial<Agent>) => void }) {
  const savedFile = agentFile(agent);
  const savedCode = agentCode(agent);
  const [kind, setKind] = useState<"md" | "ts">("md");
  const [file, setFile] = useState(savedFile);
  const [code, setCode] = useState(savedCode);
  const [applied, setApplied] = useState(false);
  useEffect(() => setFile(savedFile), [savedFile]);
  useEffect(() => setCode(savedCode), [savedCode]);
  const saved = kind === "md" ? savedFile : savedCode;
  const text = kind === "md" ? file : code;
  const setText = kind === "md" ? setFile : setCode;
  const changed = text.trim() !== saved.trim();
  const check = kind === "md" ? readAgentFile(text, access) : readAgentCode(text, access);
  return (
    <ItemSection title="As a file" variant="rule" testId="agent-file" meta={<span className="font-mono text-[12px]">{agentFilePath(agent, kind)}</span>}>
      <div className="flex flex-col gap-3 py-3">
        <p className="text-[13px] leading-5 text-gray-700">
          {kind === "md"
            ? "Everything above, as one Markdown file. Edit it here, or keep it in a repo and review changes like code."
            : "The same agent in TypeScript, for a repo that defines its agents in code. OpenWork reads the values and never runs the file."}
        </p>
        <DenSegmented aria-label="File format" value={kind} onChange={setKind} className="self-start"
          options={[{ value: "md", label: "Markdown" }, { value: "ts", label: "TypeScript" }]} optionTestId={(value) => `agent-file-${value}`} />
        <DenTextarea key={kind} rows={14} value={text} spellCheck={false} aria-label={kind === "md" ? "Agent file" : "Agent file in TypeScript"}
          className="resize-none font-mono text-[12px] leading-5 [field-sizing:content]"
          onChange={(event) => { setText(event.target.value); setApplied(false); }} data-testid={kind === "md" ? "agent-file-text" : "agent-file-code"} />
        {changed ? (
          <ul className="flex flex-col gap-1" data-testid="agent-file-check">
            {check.problems.map((problem) => <li key={problem} className="text-[12px] leading-4 text-red-600" data-testid="agent-file-problem">{problem}</li>)}
            {check.warnings.map((warning) => <li key={warning} data-testid="agent-file-warning"><LockNote>{warning}</LockNote></li>)}
          </ul>
        ) : null}
        <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 flex-1 text-[12px] leading-4 text-gray-500" role="status">
            {applied && !changed ? "Applied. The settings above show the same thing." : "Whether it is on, which routines are paused and who has access are not part of the file."}
          </span>
          {changed ? (
            <span className="ml-auto flex gap-2">
              <DenButton variant="secondary" size="xs" onClick={() => setText(saved)}>Discard</DenButton>
              <DenButton size="xs" disabled={check.patch === null} data-testid="agent-file-apply"
                onClick={() => { if (check.patch) { onApply(check.patch); setApplied(true); } }}>Apply</DenButton>
            </span>
          ) : null}
        </div>
      </div>
    </ItemSection>
  );
}

function HourSelect({ label, value, from, to, onChange }: { label: string; value: number; from: number; to: number; onChange: (hour: number) => void }) {
  const hours = Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);
  return (
    <div className="w-24">
      <DenSelect size="sm" aria-label={label} menuWidth="trigger" value={String(value)} onChange={(event) => onChange(Number(event.target.value))}>
        {hours.map((hour) => <option key={hour} value={String(hour)}>{hourLabel(hour)}</option>)}
      </DenSelect>
    </div>
  );
}

// OpenWork's own tools, allowed or blocked like any app's. Sessions it starts keep its limits.
function OpenWorkSection({ agent, onPatch }: { agent: Agent; onPatch: (patch: Partial<Agent>) => void }) {
  return (
    <ItemSection title="OpenWork" variant="rule" testId="agent-openwork" meta="Sessions it starts keep its limits">
      <div className="flex flex-col divide-y divide-gray-100">
        {OPENWORK_AREAS.map((area) => (
          <ConnectorAccessRow
            key={area.id}
            connector={area}
            logo={<img src="/openwork-mark.svg" alt="" className="h-5 w-5 shrink-0" />}
            tools={agent.openwork[area.id]}
            blocked={[]}
            connected
            onTools={(tools) => onPatch({ openwork: { ...agent.openwork, [area.id]: tools } })}
            onConnect={() => undefined}
          />
        ))}
      </div>
    </ItemSection>
  );
}

// Every run is a fresh session, in OpenWork Cloud or on one of your computers. A few run at once.
function WhereSection({ agent, access, onPatch }: { agent: Agent; access: Access; onPatch: (patch: Partial<Agent>) => void }) {
  const set = (cloud: boolean, computers: string[]) => {
    if (!cloud && computers.length === 0) return;
    onPatch({ runsOn: { cloud, computers } });
  };
  const only = (id: string) => agent.runsOn.computers.length + (agent.runsOn.cloud ? 1 : 0) === 1 && (id === "cloud" ? agent.runsOn.cloud : agent.runsOn.computers.includes(id));
  return (
    <ItemSection title="Where it works" variant="rule" testId="agent-where" meta={`Up to ${access.atOnce} at once`}>
      <div className="flex flex-col divide-y divide-gray-100">
        <Row label="OpenWork Cloud" note={<span className="text-[12px] leading-4 text-gray-500">Works while your computers are off.</span>}>
          <DenSwitch size="sm" aria-label="OpenWork Cloud" checked={agent.runsOn.cloud} disabled={only("cloud")} onChange={(cloud) => set(cloud, agent.runsOn.computers)} />
        </Row>
        {MY_COMPUTERS.map((computer) => (
          <Row key={computer.id} label={computer.name} testId={`agent-where-${computer.id}`}
            note={access.cloudOnly ? <LockNote>Your admin allows OpenWork Cloud only.</LockNote> : <span className="text-[12px] leading-4 text-gray-500">{computer.online ? "Online" : "Offline. Its runs wait until it is back."}</span>}>
            <DenSwitch size="sm" aria-label={computer.name} checked={!access.cloudOnly && agent.runsOn.computers.includes(computer.id)} disabled={access.cloudOnly || only(computer.id)}
              onChange={(on) => set(agent.runsOn.cloud, on ? [...agent.runsOn.computers, computer.id] : agent.runsOn.computers.filter((id) => id !== computer.id))} />
          </Row>
        ))}
        <div className="py-2.5"><LockNote>{`Your admin lets each agent work on ${access.atOnce} things at once. Another one waits for a free slot.`}</LockNote></div>
      </div>
    </ItemSection>
  );
}

// A level is a shortcut. Underneath, every tool is either allowed or blocked.
function ConnectorAccessRow({ connector, logo, tools, blocked, connected, onTools, onConnect }: {
  connector: ToolSet;
  logo?: ReactNode;
  tools: string[];
  blocked: string[];
  connected: boolean;
  onTools: (tools: string[]) => void;
  onConnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const every = toolsForLevel(connector, "write");
  const preset = presetOf(connector, tools);
  const allowed = tools.filter((tool) => !blocked.includes(tool));
  const stopped = tools.filter((tool) => blocked.includes(tool));
  const noneLeft = every.every((tool) => blocked.includes(tool));
  const noWrites = connector.writeTools.every((tool) => blocked.includes(tool));
  const options: DenSegmentedOption<Preset>[] = [
    { value: "none", label: PRESET_LABEL.none },
    { value: "read", label: PRESET_LABEL.read, disabled: noneLeft },
    { value: "write", label: PRESET_LABEL.write, disabled: noWrites },
    { value: "custom", label: PRESET_LABEL.custom, disabled: noneLeft },
  ];
  const choose = (next: Preset) => {
    if (next === "custom") {
      setOpen(true);
      return;
    }
    onTools(toolsForLevel(connector, next));
  };
  const state = !connected
    ? "Not connected."
    : stopped.length > 0 ? `${toolCount(connector, allowed)} in use.` : toolsLine(connector, tools);
  return (
    <div className="flex flex-col gap-2 py-3" data-testid={`agent-connector-${connector.id}`} data-level={preset} data-tools={connected ? allowed.join(",") : ""}>
      <div className="flex min-h-[36px] items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-3">
          <ConnectorLogo name={connector.name} url={connector.url} size="xs" />
          <span className="flex min-w-0 flex-col">
            <span className={`truncate text-[13px] font-medium ${tools.length === 0 ? "text-gray-500" : "text-gray-900"}`}>{connector.name}</span>
            <span className="text-[12px] leading-4 text-gray-500">{state}</span>
          </span>
        </span>
        {connected ? (
          <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg pl-2 pr-1 text-[12px] font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900" data-testid={`agent-connector-${connector.id}-tools`}>
            {open ? "Hide tools" : "Each tool"}
            <ChevronRight className={`h-4 w-4 transition-transform duration-150 ease-out motion-reduce:transition-none ${open ? "rotate-90" : ""}`} aria-hidden />
          </button>
        ) : (
          <button type="button" onClick={onConnect} className="shrink-0 whitespace-nowrap text-[12px] font-medium text-gray-900 underline-offset-2 hover:underline">{`Connect ${connector.name}`}</button>
        )}
      </div>
      {connected ? (
        <div className="pl-9">
          <DenSegmented aria-label={`What it can do in ${connector.name}`} value={preset} onChange={choose} options={options} optionTestId={(value) => `agent-connector-${connector.id}-${value}`} />
        </div>
      ) : null}
      {connected && noneLeft ? <div className="pl-9"><LockNote>Not allowed for agents by your admin.</LockNote></div> : null}
      {connected && !noneLeft && noWrites ? <div className="pl-9"><LockNote>Your admin allows read only.</LockNote></div> : null}
      {connected && !noWrites && stopped.length > 0 ? <div className="pl-9"><LockNote>{adminBlockNote(stopped)}</LockNote></div> : null}
      {connected && open ? (
        <div className="flex flex-col pl-9" data-testid={`agent-connector-${connector.id}-tool-list`}>
          {every.map((tool) => {
            const locked = blocked.includes(tool);
            const on = tools.includes(tool) && !locked;
            return (
              <div key={tool} className="flex min-h-8 items-center justify-between gap-3 border-t border-gray-100 py-1" data-testid={`agent-tool-${connector.id}-${tool}`} data-state={locked ? "locked" : on ? "allowed" : "blocked"}>
                <span className="flex min-w-0 flex-col">
                  <span className={`truncate text-[13px] leading-5 ${on ? "text-gray-900" : "text-gray-500"}`}>{toolLabel(tool)}</span>
                  <span className="text-[12px] leading-4 text-gray-500">{locked ? "Blocked by your admin" : isWriteTool(connector, tool) ? "Writes" : "Reads"}</span>
                </span>
                <DenSwitch size="sm" aria-label={`${toolLabel(tool)} in ${connector.name}`} checked={on} disabled={locked}
                  onChange={(next) => onTools(next ? every.filter((entry) => entry === tool || tools.includes(entry)) : tools.filter((entry) => entry !== tool))} />
              </div>
            );
          })}
          <p className="border-t border-gray-100 pt-2 text-[12px] leading-4 text-gray-500">
            {connector.id === "sessions"
              ? `Never allowed for any agent: ${listWords(connector.neverTools.map((tool) => toolLabel(tool).toLowerCase()))}. Those stay yours.`
              : `Never allowed for any agent: ${listWords(connector.neverTools.map((tool) => toolLabel(tool).toLowerCase()))}. ${connector.neverTools.length === 1 ? "It removes" : "They remove"} things for good.`}
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// An agent someone shared with you as a collaborator: read it, switch it on for yourself, copy it
// ---------------------------------------------------------------------------

export function SharedAgentSettings({ agent, access, connected, atAgentLimit, onPatch, onCopy, onLeave, onConnect }: {
  agent: Agent;
  access: Access;
  connected: Record<ConnectorId, boolean>;
  atAgentLimit: boolean;
  onPatch: (patch: Partial<Agent>) => void;
  onCopy: () => void;
  onLeave: () => void;
  onConnect: (id: ConnectorId) => void;
}) {
  const owner = personName(agent.owner);
  const ownerFirst = firstNameOf(agent.owner);
  const budget = effectiveBudget(agent, access);
  const over = overBudget(agent, access);
  const uses = CONNECTORS.filter((connector) => agent.tools[connector.id].length > 0);
  const sentence = over
    ? `Your use reached ${formatWorkbotCost(agent.spentMicro)} of ${formatWorkbotCost(budget ?? 0)}. It works for you again next month, or when ${ownerFirst} raises its budget.`
    : agent.on
      ? `${nextRunText(agent)}. It works with your own accounts, and ${ownerFirst} never sees what it finds for you.`
      : `Off for you. You can still ask it things in its conversation. Either way it works with your own accounts, and ${ownerFirst} never sees what it finds for you.`;

  return (
    <div className="flex flex-col gap-6" data-testid="agent-settings" data-owner={agent.owner} data-role="collaborator">
      <Status title="Run its routines for me" sentence={sentence} state={agent.on ? (over ? "over_budget" : "on") : "off"}>
        <DenSwitch aria-label={`Run ${agent.name}'s routines for you`} checked={agent.on} onChange={(on) => onPatch({ on })} testId="agent-on" />
      </Status>

      <ItemSection title="What it does" variant="rule" testId="agent-instructions">
        <div className="flex flex-col gap-2 py-3">
          <p className="whitespace-pre-line text-[13px] leading-5 text-gray-900" data-testid="agent-instructions-text">{agent.instructions}</p>
          <LockNote>{`Shared by ${owner}. You are a collaborator: you can use it, and only ${ownerFirst} and the managers ${ownerFirst} picks can change it.`}</LockNote>
        </div>
      </ItemSection>

      <ItemSection title="Routines" variant="rule" testId="agent-routines" meta={routinesLine(agent)}>
        <div className="flex flex-col divide-y divide-gray-100">
          {agent.routines.length === 0 ? <p className="py-3 text-[13px] leading-5 text-gray-500">No routines. It works only when you ask it in its conversation.</p> : null}
          {agent.routines.map((routine) => (
            <div key={routine.id} className="flex min-h-[44px] flex-col justify-center py-2" data-testid={`agent-routine-${routine.id}`} data-on={routine.on ? "true" : "false"}>
              <span className={`truncate text-[13px] font-medium ${routine.on ? "text-gray-900" : "text-gray-500"}`}>{routine.name}</span>
              <span className="text-[12px] leading-4 text-gray-500">{routine.on ? routineWhen(routine) : `Paused by ${ownerFirst}`}</span>
            </div>
          ))}
        </div>
      </ItemSection>

      <ItemSection title="What it uses" variant="rule" testId="agent-connectors" meta="Your own accounts">
        <div className="flex flex-col divide-y divide-gray-100">
          {uses.map((connector) => {
            const wanted = agent.tools[connector.id];
            const allowed = effectiveTools(agent, access, connected, connector.id);
            const stopped = wanted.filter((tool) => access.blocked[connector.id].includes(tool));
            return (
              <div key={connector.id} className="flex flex-col gap-1 py-2.5" data-testid={`agent-connector-${connector.id}`} data-level={presetOf(connector, allowed)}>
                <div className="flex min-h-[36px] items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-3">
                    <ConnectorLogo name={connector.name} url={connector.url} size="xs" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[13px] font-medium text-gray-900">{connector.name}</span>
                      <span className="text-[12px] leading-4 text-gray-500">
                        {connected[connector.id] ? toolsLine(connector, allowed) : "Not connected. It skips this for you."}
                      </span>
                    </span>
                  </span>
                  {connected[connector.id] ? (
                    <span className="shrink-0 text-[12px] text-gray-500">{toolCount(connector, allowed)}</span>
                  ) : (
                    <button type="button" onClick={() => onConnect(connector.id)} className="shrink-0 whitespace-nowrap text-[12px] font-medium text-gray-900 underline-offset-2 hover:underline">{`Connect ${connector.name}`}</button>
                  )}
                </div>
                {connected[connector.id] && stopped.length > 0 ? <div className="pl-9"><LockNote>{adminBlockNote(stopped)}</LockNote></div> : null}
              </div>
            );
          })}
        </div>
      </ItemSection>

      <ItemSection title="What it costs" variant="rule" testId="agent-budget">
        <div className="flex flex-col divide-y divide-gray-100">
          <Row label="Paid from" testId="agent-paid-by">
            <span className="text-[13px] text-gray-700">{paidByLine(agent)}</span>
          </Row>
          <SpendThisMonth agent={agent} access={access} caption={`Your own use. Only ${ownerFirst} can change its budget.`} />
        </div>
      </ItemSection>

      <div className="flex flex-col gap-2 border-t border-gray-100 pt-4 pb-2">
        <span className="text-[12px] leading-4 text-gray-500">
          {atAgentLimit ? `Your admin allows ${access.maxAgents} agents of your own.` : "A copy is yours to change. It counts as one of your own agents."}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <DenButton variant="secondary" size="sm" icon={Copy} disabled={atAgentLimit} onClick={onCopy} data-testid="agent-copy">Make my own copy</DenButton>
          <DenButton variant="secondary" size="sm" onClick={onLeave} data-testid="agent-leave">Remove from my list</DenButton>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Everything your agents spent this month, against your limit and the org's
// ---------------------------------------------------------------------------

export function MonthSpend({ agents, access }: { agents: Agent[]; access: Access }) {
  const used = agents.filter(usedByMe);
  const sum = (list: Agent[]) => list.reduce((total, agent) => total + agent.spentMicro, 0);
  const onMe = sum(used.filter((agent) => agent.paidBy === "me"));
  const onOrg = sum(used.filter((agent) => agent.paidBy === "org"));
  const ownerUsed = MEMBER.ownSpendMicro + onMe;
  const orgUsed = orgBudgetSpent(agents);
  return (
    <ItemSection title="This month" variant="rule" testId="agents-month" meta={`${formatWorkbotCost(sum(used))} across the agents you use`}>
      <div className="grid gap-x-10 gap-y-5 py-4 md:grid-cols-2">
        <DenUsageMeter
          label="Your monthly limit"
          {...spendMeter(ownerUsed, MEMBER.limitMicro)}
          readout={`${formatWorkbotCost(ownerUsed)} of ${formatWorkbotCost(MEMBER.limitMicro)}`}
          caption={`${formatWorkbotCost(MEMBER.ownSpendMicro)} from your own chats, ${formatWorkbotCost(onMe)} from agents you pay for.`}
        />
        {access.orgBudget.offered ? (
          <DenUsageMeter
            label="Org agent budget"
            {...spendMeter(orgUsed, access.orgBudget.monthlyMicro)}
            readout={`${formatWorkbotCost(orgUsed)} of ${formatWorkbotCost(access.orgBudget.monthlyMicro)}`}
            caption={`Shared by everyone in Sample org. ${formatWorkbotCost(onOrg)} of it is from agents you use.`}
          />
        ) : (
          <LockNote>Your admin hasn't set up an org budget for agents. Every agent counts toward its owner's limit.</LockNote>
        )}
      </div>
    </ItemSection>
  );
}
