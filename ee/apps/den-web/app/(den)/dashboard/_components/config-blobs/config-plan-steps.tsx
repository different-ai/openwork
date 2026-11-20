"use client";

import {
  type ConfigAreaKey,
  type ConfigDecisions,
  type ConfigFieldChange,
  type ConfigPlan,
  type ConfigPlanItem,
  type ConfigPlanRef,
  type ConfigPlanSecret,
  type ConfigSecretInput,
  parseConfigRef,
} from "@openwork/types/den/config-blobs";
import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { DenButton } from "../../../_components/ui/button";
import { DenCheckbox } from "../../../_components/ui/checkbox";
import { DenChip } from "../../../_components/ui/chip";
import { DenInput } from "../../../_components/ui/input";
import { DenOptionCard } from "../../../_components/ui/option-card";
import { DenSecretInput } from "../../../_components/ui/secret-input";
import { DenSelect } from "../../../_components/ui/select";
import { DenSwitch } from "../../../_components/ui/switch";
import {
  CONFIG_OP_LABELS,
  type ConfigPlanEntry,
  type ConfigRefEntry,
  type ConfigRefGroup,
  decideRefs,
  deletesHeading,
  formatFieldChange,
  formatFieldPath,
  formatFieldValue,
  formatScore,
  groupByOp,
  inviteCount,
  isDeletable,
  isPeopleRef,
  isRefChoiceRefused,
  isRefOpen,
  itemName,
  keepableSecrets,
  matchDecision,
  matchEntries,
  matchTierLabel,
  needsMatch,
  planEntries,
  refChoice,
  refGroupChoice,
  refGroups,
  refHandle,
  refName,
  refusesChoice,
  targetChoices,
} from "./config-blobs-model";

export type StepProps = {
  plan: ConfigPlan;
  decisions: ConfigDecisions;
  editable: boolean;
  saving: boolean;
  onDecisions: (next: ConfigDecisions) => void;
};

function StepEmpty({ children }: { children: string }) {
  return <p className="py-4 text-[13px] text-gray-500">{children}</p>;
}

function ItemHeading({ entry }: { entry: ConfigPlanEntry }) {
  return (
    <p className="text-[13px] text-gray-900">
      <span className="font-medium">{itemName(entry.item)}</span>
      <span className="text-gray-500"> in {entry.areaLabel}</span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Match

export function MatchStep({ plan, decisions, editable, saving, onDecisions }: StepProps) {
  const entries = matchEntries(plan, decisions);
  if (entries.length === 0) return <StepEmpty>Every item matched on its own.</StepEmpty>;

  function choose(entry: ConfigPlanEntry, targetId: string) {
    const matches = decisions.matches.filter((match) => !(match.area === entry.area && match.ref === entry.item.ref));
    onDecisions({ ...decisions, matches: [...matches, { area: entry.area, ref: entry.item.ref, targetId }] });
  }

  return (
    <div className="flex flex-col divide-y divide-gray-100" data-testid="config-step-match">
      {entries.map((entry) => {
        const selected = matchDecision(decisions, entry);
        const candidates = [...(entry.item.candidates ?? [])].sort((a, b) => b.score - a.score);
        const target = entry.item.target;
        if (target && !candidates.some((candidate) => candidate.id === target.id)) {
          candidates.unshift({ id: target.id, name: target.name, score: 1, reasons: entry.item.reasons ?? [] });
        }
        const suggested = target?.id ?? (entry.item.op === "create" ? "create" : null);
        const name = `config-match-${entry.area}-${entry.item.ref}`;
        return (
          <fieldset key={`${entry.area}:${entry.item.ref}`} className="flex flex-col gap-2 py-4" disabled={!editable || saving} data-testid="config-match-item">
            <legend className="sr-only">Match for {itemName(entry.item)}</legend>
            <div className="flex flex-wrap items-center gap-2">
              <ItemHeading entry={entry} />
              {needsMatch(entry.item) ? <DenChip tone="warning">Choose one</DenChip> : null}
            </div>
            {entry.item.flags.includes("conflict.identity") ? (
              <p className="text-[12px] text-gray-500">Its ID and its name point to different items here.</p>
            ) : null}
            <DenOptionCard
              type="radio"
              name={name}
              checked={selected === "create"}
              onChange={() => choose(entry, "create")}
              title={`Add as a new item${suggested === "create" && selected === null ? " (suggested)" : ""}`}
              disabled={!editable || saving}
              testId="config-match-create"
            />
            {candidates.map((candidate) => (
              <DenOptionCard
                key={candidate.id}
                type="radio"
                name={name}
                checked={selected === candidate.id}
                onChange={() => choose(entry, candidate.id)}
                title={`Same as “${candidate.name}”${suggested === candidate.id && selected === null ? " (suggested)" : ""}`}
                description={`${formatScore(candidate.score)} match${candidate.reasons.length > 0 ? `: ${candidate.reasons.join(", ")}` : ""}`}
                disabled={!editable || saving}
                testId="config-match-candidate"
              />
            ))}
          </fieldset>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// References

export function ReferencesStep({ plan, decisions, editable, saving, onDecisions }: StepProps) {
  const groups = refGroups(plan);
  if (groups.length === 0) return <StepEmpty>Every reference points to something that exists.</StepEmpty>;
  const disabled = !editable || saving;
  const decide = (uses: readonly ConfigRefEntry[], choice: string) => onDecisions(decideRefs(decisions, uses, choice));
  // Beside rows that open, a row with nothing to open keeps the same left edge for its name.
  const inset = groups.some((group) => group.uses.length > 1);

  return (
    <div className="flex flex-col divide-y divide-gray-100" data-testid="config-step-references">
      {groups.map((group) => group.uses.length === 1 ? (
        <RefUseRow key={group.key} plan={plan} decisions={decisions} entry={group.uses[0]} title={group.name} inset={inset} disabled={disabled} onChoose={decide} />
      ) : (
        <RefGroupRow key={group.key} plan={plan} decisions={decisions} group={group} disabled={disabled} onChoose={decide} />
      ))}
    </div>
  );
}

type RefRowProps = {
  plan: ConfigPlan;
  decisions: ConfigDecisions;
  disabled: boolean;
  onChoose: (uses: readonly ConfigRefEntry[], choice: string) => void;
};

/** What can be done with a reference: map it to something here, invite the person, or leave it out. */
function RefChoiceSelect({ plan, uses, label, value, placeholder, disabled, testId, onChange }: {
  plan: ConfigPlan;
  /** The uses this select decides: a choice is offered while at least one of them can take it. */
  uses: readonly ConfigRefEntry[];
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  testId: string;
  onChange: (choice: string) => void;
}) {
  const reference = uses[0]?.reference;
  const parsed = reference ? parseConfigRef(reference.ref) : null;
  const choices = parsed ? targetChoices(plan, parsed.area) : [];
  // A choice already made stays listed, so the select can show it.
  const offers = (choice: string) => value === choice || uses.some((entry) => !refusesChoice(entry.reference, choice));
  return (
    <div className="w-60">
      <DenSelect aria-label={label} value={value} disabled={disabled} menuWidth="trigger" data-testid={testId} onChange={(event) => onChange(event.target.value)}>
        <option value="" disabled>{placeholder}</option>
        {choices.map((choice) => <option key={choice.id} value={`target:${choice.id}`}>Use “{choice.name}”</option>)}
        {reference && isPeopleRef(reference) && offers("invite") ? <option value="invite">Invite this person</option> : null}
        {offers("drop") ? <option value="drop">Leave it out</option> : null}
      </DenSelect>
    </div>
  );
}

/** One use of a reference. `title` names the reference; inside a group the row is named by the item that uses it. */
function RefUseRow({ plan, decisions, entry, title, inset, disabled, onChoose }: RefRowProps & { entry: ConfigRefEntry; title?: string; inset?: boolean }) {
  const { reference } = entry;
  const choice = refChoice(decisions, entry);
  const refused = isRefChoiceRefused(decisions, entry);
  // Said before any choice is made: this use has no "Leave it out", and why.
  const required = isRefOpen(reference) && refusesChoice(reference, "drop");
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4" data-testid="config-ref-item">
      <div className={`min-w-0 ${inset ? "pl-5" : ""}`}>
        {title ? (
          <>
            <p className="truncate text-[13px] font-medium text-gray-900" title={refHandle(reference)}>{title}</p>
            <p className="truncate text-[12px] text-gray-500">Used by {itemName(entry.item)} in {entry.areaLabel}</p>
          </>
        ) : (
          <p className="truncate text-[13px] text-gray-900">{itemName(entry.item)}<span className="text-gray-500"> in {entry.areaLabel}</span></p>
        )}
        {refused || required ? (
          <p className="text-[12px] text-gray-500" data-testid="config-ref-refused">
            {required || choice === "drop" ? "This item can’t be imported without it. Choose one here, or leave the item out on Review." : "That choice can’t be used here. Choose another."}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 sm:w-80">
        {isRefOpen(reference) ? <DenChip tone="warning">Choose</DenChip> : null}
        <RefChoiceSelect
          plan={plan}
          uses={[entry]}
          label={`What to do with ${refName(reference)} in ${itemName(entry.item)}`}
          value={choice}
          placeholder="Choose what to do"
          disabled={disabled}
          testId="config-ref-select"
          onChange={(next) => onChoose([entry], next)}
        />
      </div>
    </div>
  );
}

/** A person or item several items point to: one choice covers every use; each use can still differ. */
function RefGroupRow({ plan, decisions, group, disabled, onChoose }: RefRowProps & { group: ConfigRefGroup }) {
  const usesId = useId();
  const refused = group.uses.some((entry) => isRefChoiceRefused(decisions, entry));
  const choice = refGroupChoice(decisions, group);
  const count = group.uses.length;
  const decided = count - group.open;
  // The uses a choice for all did not settle are the answer here, so they show without a click (DESIGN.md S3).
  const [toggled, setToggled] = useState<boolean | null>(null);
  const expanded = toggled ?? (refused || (group.open > 0 && decided > 0));
  return (
    <div className="py-3" data-testid="config-ref-group">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={usesId}
          onClick={() => setToggled(!expanded)}
          className="flex min-w-0 items-start gap-1.5 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900/20"
          data-testid="config-ref-group-toggle"
        >
          <ChevronRight className={`mt-0.5 size-3.5 shrink-0 text-gray-400 transition-transform duration-150 ease-out motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`} strokeWidth={1.5} aria-hidden="true" />
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium text-gray-900" title={refHandle(group.reference)}>{group.name}</span>
            <span className="block truncate text-[12px] text-gray-500">
              {group.open > 0 && decided > 0 ? `${group.open} of ${count} items still ${group.open === 1 ? "needs" : "need"} a choice` : `Used by ${count} items`}
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center justify-end gap-2 sm:w-80">
          {group.open > 0 ? <DenChip tone="warning">Choose</DenChip> : null}
          <RefChoiceSelect
            plan={plan}
            uses={group.uses}
            label={`What to do with ${group.name} in all ${count} items`}
            value={choice ?? ""}
            placeholder={choice === null ? "Different choices" : `Choose for all ${count}`}
            disabled={disabled}
            testId="config-ref-group-select"
            onChange={(next) => onChoose(group.uses, next)}
          />
        </div>
      </div>
      {expanded ? (
        <div id={usesId} className="mt-1 flex flex-col divide-y divide-gray-100 pl-5">
          {group.uses.map((entry) => (
            <RefUseRow key={`${entry.area}:${entry.item.ref}:${entry.reference.path}`} plan={plan} decisions={decisions} entry={entry} disabled={disabled} onChoose={onChoose} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Secrets

type SecretChoice = "keep" | "value" | "env" | "unset";

export function SecretsStep({ plan, editable, saving, allowEnv, onInput }: {
  plan: ConfigPlan;
  editable: boolean;
  saving: boolean;
  /** `env` decisions are offered only where the server allows them (self-hosted with an operator allowlist). */
  allowEnv: boolean;
  onInput: (input: ConfigSecretInput | ConfigSecretInput[]) => Promise<void>;
}) {
  const secrets = planEntries(plan).flatMap((entry) => (entry.item.secrets ?? []).map((secret) => ({ entry, secret })));
  if (secrets.length === 0) return <StepEmpty>No secrets in this file.</StepEmpty>;
  const keepable = keepableSecrets(plan);
  return (
    <div className="flex flex-col gap-2" data-testid="config-step-secrets">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-gray-500">Secret values are never in the file. Choose what each one should be here.</p>
        {editable && keepable.length > 1 ? (
          <DenButton variant="secondary" size="sm" disabled={saving} onClick={() => void onInput(keepable.map((path) => ({ path, decision: "keep" })))} data-testid="config-secrets-keep-all">
            Keep all current values ({keepable.length})
          </DenButton>
        ) : null}
      </div>
      <div className="flex flex-col divide-y divide-gray-100">
        {secrets.map(({ entry, secret }) => (
          <SecretRow key={`${secret.path}:${secret.decision ?? ""}`} entry={entry} secret={secret} editable={editable} saving={saving} allowEnv={allowEnv || secret.decision === "env"} onInput={onInput} />
        ))}
      </div>
    </div>
  );
}

function SecretRow({ entry, secret, editable, saving, allowEnv, onInput }: {
  entry: ConfigPlanEntry;
  secret: ConfigPlanSecret;
  editable: boolean;
  saving: boolean;
  allowEnv: boolean;
  onInput: (input: ConfigSecretInput | ConfigSecretInput[]) => Promise<void>;
}) {
  const [choice, setChoice] = useState<SecretChoice | "">(secret.decision ?? "");
  const [value, setValue] = useState("");
  const [env, setEnv] = useState(secret.env ?? "");
  // The server only reads variables in its import namespace (config-blobs/env-secrets.ts).
  const envValid = /^OPENWORK_IMPORT_[A-Z0-9_]{1,112}$/.test(env);

  async function pick(next: SecretChoice | "") {
    setChoice(next);
    if (next === "keep" || next === "unset") await onInput({ path: secret.path, decision: next });
  }

  async function saveValue() {
    await onInput({ path: secret.path, decision: "value", value });
    setValue("");
  }

  return (
    <div className="flex flex-col gap-2 py-3" data-testid="config-secret-item">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-gray-900">{formatFieldPath(secret.field)}</p>
          <p className="truncate text-[12px] text-gray-500">{itemName(entry.item)} in {entry.areaLabel}</p>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 sm:w-80">
          {secret.decision === null && entry.item.flags.includes("needs_input") ? <DenChip tone="warning">Choose</DenChip> : null}
          <div className="w-60">
            <DenSelect
              aria-label={`Secret for ${formatFieldPath(secret.field)}`}
              value={choice}
              disabled={!editable || saving}
              menuWidth="trigger"
              onChange={(event) => {
                const next = event.target.value;
                void pick(next === "keep" || next === "value" || next === "env" || next === "unset" ? next : "");
              }}
            >
              <option value="" disabled>Choose what to do</option>
              {secret.targetHasValue ? <option value="keep">Keep the current value</option> : null}
              <option value="value">Enter a value</option>
              {allowEnv ? <option value="env">Read from an environment variable</option> : null}
              <option value="unset">Leave it empty</option>
            </DenSelect>
          </div>
        </div>
      </div>
      {choice === "value" ? (
        <div className="flex items-center gap-2 sm:pl-0">
          <div className="min-w-0 flex-1">
            <DenSecretInput
              value={value}
              onChange={setValue}
              placeholder="Paste the value"
              disabled={!editable || saving}
              saved={secret.decision === "value" && value === ""}
              aria-label={`Value for ${formatFieldPath(secret.field)}`}
            />
          </div>
          {value !== "" || secret.decision !== "value" ? (
            <DenButton variant="secondary" disabled={!editable || value === ""} loading={saving} onClick={() => void saveValue()}>Save value</DenButton>
          ) : null}
        </div>
      ) : null}
      {choice === "env" ? (
        <div className="flex items-center gap-2">
          <DenInput
            value={env}
            onChange={(event) => setEnv(event.target.value.toUpperCase())}
            placeholder="OPENWORK_IMPORT_OPENAI_API_KEY"
            className="font-mono"
            aria-label={`Environment variable for ${formatFieldPath(secret.field)}`}
            disabled={!editable || saving}
          />
          <DenButton variant="secondary" disabled={!editable || !envValid || (secret.decision === "env" && secret.env === env)} loading={saving} onClick={() => void onInput({ path: secret.path, decision: "env", env })}>
            Use variable
          </DenButton>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// People

export function PeopleStep({ plan, decisions, editable, saving, onDecisions }: StepProps) {
  const count = inviteCount(plan);
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 py-3" data-testid="config-step-people">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-gray-900">Send invite emails now</p>
        <p className="text-[12px] text-gray-500">{count} {count === 1 ? "invitation" : "invitations"}. Off: invitations are created without an email.</p>
      </div>
      <DenSwitch
        aria-label="Send invite emails now"
        checked={decisions.people.sendInviteEmails}
        disabled={!editable || saving}
        onChange={(checked) => onDecisions({ ...decisions, people: { sendInviteEmails: checked } })}
        testId="config-people-send-emails"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review

export function ReviewStep({ plan, decisions, editable, saving, onDecisions, confirmed, onConfirm, closed = false, restore = false }: StepProps & {
  confirmed: ReadonlySet<string>;
  onConfirm: (key: string, checked: boolean) => void;
  /** Applied or closed: the diff reads Before / After and decision controls are hidden. */
  closed?: boolean;
  /** A "Restore previous config" request: its removals are what the restored change added. */
  restore?: boolean;
}) {
  // Areas where nothing changes collapse into one line at the end.
  const changed = plan.areas.filter((area) => area.items.some((item) => isDeletable(item, plan.mode) || !["unchanged", "untouched"].includes(item.op)));
  const quiet = plan.areas.filter((area) => !changed.includes(area));
  return (
    <div className="flex flex-col gap-8" data-testid="config-step-review">
      {changed.length === 0 ? <StepEmpty>Nothing in this file differs from what is here.</StepEmpty> : null}
      {changed.map((area) => (
        <ReviewArea
          key={area.area}
          plan={plan}
          area={area}
          decisions={decisions}
          editable={editable}
          saving={saving}
          onDecisions={onDecisions}
          confirmed={confirmed}
          onConfirm={onConfirm}
          closed={closed}
          restore={restore}
        />
      ))}
      {quiet.length > 0 ? (
        <details className="group" data-testid="config-review-quiet">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] text-gray-500 hover:text-gray-900">
            <ChevronRight className="size-3.5 transition-transform duration-150 ease-out group-open:rotate-90" strokeWidth={1.5} aria-hidden="true" />
            No changes in {quiet.map((area) => area.label).join(", ")}
          </summary>
          <ul className="mt-2 flex flex-col gap-1 pl-5 text-[13px] text-gray-600">
            {quiet.map((area) => (
              <li key={area.area}>
                <span className="text-gray-900">{area.label}</span>
                {area.items.length > 0 ? <span className="text-gray-500">: {area.items.map((item) => itemName(item)).join(", ")}</span> : <span className="text-gray-500">: nothing in the file</span>}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function destructiveKey(area: ConfigAreaKey, item: ConfigPlanItem): string {
  return `${area}:${item.ref}`;
}

/** Destructive changes other than mirror removals; each needs a tick before approval. */
export function destructiveEntries(plan: ConfigPlan | null): ConfigPlanEntry[] {
  if (!plan) return [];
  return planEntries(plan).filter((entry) => entry.item.flags.includes("destructive") && !isDeletable(entry.item, plan.mode) && entry.item.op !== "skip");
}

function ReviewArea({ plan, area, decisions, editable, saving, onDecisions, confirmed, onConfirm, closed, restore }: StepProps & {
  area: ConfigPlan["areas"][number];
  confirmed: ReadonlySet<string>;
  onConfirm: (key: string, checked: boolean) => void;
  closed: boolean;
  restore: boolean;
}) {
  const [confirmAll, setConfirmAll] = useState<string | null>(null);
  const deletable = area.items.filter((item) => isDeletable(item, plan.mode));
  const ticked = new Set(decisions.deletes.filter((entry) => entry.area === area.area).map((entry) => entry.targetId));
  const groups = groupByOp(area.items.filter((item) => !isDeletable(item, plan.mode)));
  const quiet = groups.filter((group) => group.op === "unchanged" || group.op === "untouched");
  const loud = groups.filter((group) => group.op !== "unchanged" && group.op !== "untouched");

  function setDeletes(targetIds: string[], checked: boolean) {
    const others = decisions.deletes.filter((entry) => !(entry.area === area.area && targetIds.includes(entry.targetId)));
    onDecisions({ ...decisions, deletes: checked ? [...others, ...targetIds.map((targetId) => ({ area: area.area, targetId }))] : others });
  }

  function setOverride(item: ConfigPlanItem, checked: boolean) {
    const others = decisions.overrides.filter((entry) => !(entry.area === area.area && entry.ref === item.ref));
    onDecisions({ ...decisions, overrides: checked ? [...others, { area: area.area, ref: item.ref }] : others });
  }

  function setSkip(item: ConfigPlanItem, checked: boolean) {
    const others = decisions.skips.filter((entry) => !(entry.area === area.area && entry.ref === item.ref));
    onDecisions({ ...decisions, skips: checked ? [...others, { area: area.area, ref: item.ref }] : others });
  }

  function setRename(item: ConfigPlanItem, name: string | null) {
    const others = decisions.renames.filter((entry) => !(entry.area === area.area && entry.ref === item.ref));
    onDecisions({ ...decisions, renames: name ? [...others, { area: area.area, ref: item.ref, name }] : others });
  }

  return (
    <section className="flex flex-col gap-3" aria-label={area.label} data-testid="config-review-area" data-area={area.area}>
      <h3 className="text-[14px] font-semibold text-gray-950">{area.label}</h3>
      {loud.length === 0 && deletable.length === 0 ? <p className="text-[13px] text-gray-500">No changes.</p> : null}
      {loud.map((group) => (
        <div key={group.op} className="flex flex-col">
          <p className="pb-1 text-[12px] font-medium text-gray-500">{CONFIG_OP_LABELS[group.op]} ({group.items.length})</p>
          <div className="flex flex-col divide-y divide-gray-100 border-y border-gray-100">
            {group.items.map((item) => (
              <ReviewItem
                key={item.ref}
                item={item}
                overridden={decisions.overrides.some((entry) => entry.area === area.area && entry.ref === item.ref)}
                onOverride={(checked) => setOverride(item, checked)}
                skipped={decisions.skips.some((entry) => entry.area === area.area && entry.ref === item.ref)}
                onSkip={(checked) => setSkip(item, checked)}
                renamedTo={decisions.renames.find((entry) => entry.area === area.area && entry.ref === item.ref)?.name ?? null}
                onRename={(name) => setRename(item, name)}
                confirmed={confirmed.has(destructiveKey(area.area, item))}
                onConfirm={(checked) => onConfirm(destructiveKey(area.area, item), checked)}
                editable={editable && !saving}
                closed={closed}
              />
            ))}
          </div>
        </div>
      ))}
      {deletable.length > 0 ? (
        <div className="flex flex-col" data-testid="config-review-deletes">
          <div className="flex flex-wrap items-center gap-2 pb-1">
            <p className="mr-auto text-[12px] font-medium text-gray-500">{deletesHeading(restore)} ({ticked.size} of {deletable.length} ticked)</p>
            {editable && confirmAll === null && ticked.size < deletable.length ? (
              <DenButton variant="ghost" size="xs" onClick={() => setConfirmAll("")}>Select all</DenButton>
            ) : null}
            {editable && ticked.size > 0 ? (
              <DenButton variant="ghost" size="xs" onClick={() => setDeletes(deletable.flatMap((item) => item.target ? [item.target.id] : []), false)}>Clear</DenButton>
            ) : null}
          </div>
          {confirmAll !== null ? (
            <div className="flex flex-wrap items-center gap-2 pb-2">
              <label className="text-[13px] text-gray-700" htmlFor={`config-delete-all-${area.area}`}>Type <span className="font-mono">remove {deletable.length}</span> to tick all</label>
              <DenInput id={`config-delete-all-${area.area}`} value={confirmAll} onChange={(event) => setConfirmAll(event.target.value)} className="w-40 font-mono" data-testid="config-delete-all-confirm" />
              <DenButton
                variant="destructive"
                size="sm"
                disabled={confirmAll.trim().toLowerCase() !== `remove ${deletable.length}` || saving}
                onClick={() => { setDeletes(deletable.flatMap((item) => item.target ? [item.target.id] : []), true); setConfirmAll(null); }}
              >
                Tick all {deletable.length}
              </DenButton>
              <DenButton variant="ghost" size="sm" onClick={() => setConfirmAll(null)}>Cancel</DenButton>
            </div>
          ) : null}
          <div className="flex flex-col divide-y divide-gray-100 border-y border-gray-100">
            {deletable.map((item) => {
              const isTicked = item.target ? ticked.has(item.target.id) : false;
              const irreversible = item.irreversible ?? [];
              return (
                <div key={item.ref} className="flex flex-col gap-1 py-2" data-testid="config-delete-item">
                  <label className="flex min-h-6 items-center gap-3 text-[13px]">
                    <DenCheckbox
                      checked={isTicked}
                      disabled={!editable || saving || !item.target}
                      onCheckedChange={(checked) => item.target ? setDeletes([item.target.id], checked) : undefined}
                    />
                    <span className={`min-w-0 truncate ${isTicked ? "text-red-700" : "text-gray-900"}`}>{itemName(item)}</span>
                    {isTicked && irreversible.length > 0 ? <span className="ml-auto shrink-0"><DenChip tone="warning">Can't be undone</DenChip></span> : null}
                  </label>
                  {isTicked && irreversible.length > 0 ? (
                    <div className="pl-7 text-[12px] text-gray-700" data-testid="config-review-irreversible">
                      <p className="font-medium text-gray-900">{closed ? "Removing it:" : "If you remove it:"}</p>
                      <ul className="list-disc pl-4">{irreversible.map((effect) => <li key={effect}>{effect}</li>)}</ul>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      {quiet.map((group) => (
        <details key={group.op} className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] text-gray-500 hover:text-gray-900">
            <ChevronRight className="size-3.5 transition-transform duration-150 ease-out group-open:rotate-90" strokeWidth={1.5} aria-hidden="true" />
            {CONFIG_OP_LABELS[group.op]} ({group.items.length})
          </summary>
          <ul className="mt-1 flex flex-col gap-1 pl-5 text-[13px] text-gray-600">
            {group.items.map((item) => (
              <li key={item.ref}>
                {itemName(item)}
                {item.op === "untouched" && item.reasons && item.reasons.length > 0 ? <span className="text-gray-500">: {item.reasons.join(", ")}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}

function ReviewItem({ item, overridden, onOverride, skipped, onSkip, renamedTo, onRename, confirmed, onConfirm, editable, closed }: {
  item: ConfigPlanItem;
  overridden: boolean;
  onOverride: (checked: boolean) => void;
  skipped: boolean;
  onSkip: (checked: boolean) => void;
  renamedTo: string | null;
  onRename: (name: string | null) => void;
  confirmed: boolean;
  onConfirm: (checked: boolean) => void;
  editable: boolean;
  closed: boolean;
}) {
  const drift = item.flags.includes("drift") || overridden;
  const destructive = item.flags.includes("destructive");
  const blocked = item.flags.includes("blocked");
  const collision = item.flags.includes("collision.unique") || renamedTo !== null;
  // Items that can't go ahead as they are may be left out of this change.
  const skippable = !closed && (skipped || blocked || drift || collision || item.flags.includes("ref_unresolved"));
  // A create matched nothing here; "Matched earlier" would only echo the "Add as a new item" choice.
  const tier = item.op === "create" ? null : matchTierLabel(item.matchedBy);
  const renamed = item.op === "rename" && item.target && item.blob && item.target.name !== item.blob.name;
  const irreversible = item.op === "skip" ? [] : item.irreversible ?? [];
  return (
    <details className="group py-2" open={drift || destructive || blocked || collision || irreversible.length > 0} data-testid="config-review-item" data-op={item.op}>
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 text-[13px]">
        <ChevronRight className="size-3.5 shrink-0 text-gray-400 transition-transform duration-150 ease-out group-open:rotate-90" strokeWidth={1.5} aria-hidden="true" />
        <span className="min-w-0 truncate font-medium text-gray-900">
          {renamed ? `${item.target?.name} → ${item.blob?.name}` : itemName(item)}
        </span>
        {tier ? <span className="shrink-0 text-[12px] text-gray-500">{tier}</span> : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {blocked ? <DenChip tone="danger">Can't be applied</DenChip> : null}
          {item.flags.includes("drift") ? <DenChip tone="warning">Changed here since export</DenChip> : null}
          {destructive ? <DenChip tone="danger">Removes access or data</DenChip> : null}
          {item.flags.includes("collision.unique") ? <DenChip tone="warning">Name already used</DenChip> : null}
          {irreversible.length > 0 ? <DenChip tone="warning">Can't be undone</DenChip> : null}
          {item.flags.includes("external_effect") ? <DenChip tone="neutral">Contacts the service</DenChip> : null}
          {item.flags.includes("unsupported_field") ? <DenChip tone="neutral">Some fields dropped</DenChip> : null}
        </span>
      </summary>
      <div className="flex flex-col gap-2 pb-1 pl-5 pt-2">
        {item.fields.length > 0 ? <FieldDiff fields={item.fields} threeWay={drift} closed={closed} /> : item.op === "create" ? <p className="text-[12px] text-gray-500">New item.</p> : null}
        {item.reasons && item.reasons.length > 0 ? <p className={`text-[12px] ${blocked ? "text-red-700" : "text-gray-500"}`}>{item.reasons.join(". ")}</p> : null}
        {irreversible.length > 0 ? (
          <div className="text-[12px] text-gray-700" data-testid="config-review-irreversible">
            <p className="font-medium text-gray-900">{closed ? "Restoring the previous config can't undo:" : "Applying this can't be undone by restoring the previous config:"}</p>
            <ul className="list-disc pl-4">{irreversible.map((effect) => <li key={effect}>{effect}</li>)}</ul>
          </div>
        ) : null}
        {collision && !skipped && !closed ? <RenameField current={renamedTo} editable={editable} onRename={onRename} /> : null}
        {drift && !closed ? (
          <label className="flex items-center gap-2 text-[13px] text-gray-900">
            <DenCheckbox checked={overridden} disabled={!editable} onCheckedChange={(checked) => onOverride(checked)} data-testid="config-override" />
            Overwrite with the file’s version
          </label>
        ) : null}
        {destructive && !closed ? (
          <label className="flex items-center gap-2 text-[13px] text-gray-900">
            <DenCheckbox checked={confirmed} disabled={!editable} onCheckedChange={(checked) => onConfirm(checked)} data-testid="config-confirm-destructive" />
            I understand this removes access or data
          </label>
        ) : null}
        {skippable ? (
          <label className="flex items-center gap-2 text-[13px] text-gray-900">
            <DenCheckbox checked={skipped} disabled={!editable} onCheckedChange={(checked) => onSkip(checked)} data-testid="config-skip" />
            Leave this item out of the change
          </label>
        ) : null}
      </div>
    </details>
  );
}

/** A create whose name is already taken here: pick another name for the new item. */
function RenameField({ current, editable, onRename }: { current: string | null; editable: boolean; onRename: (name: string | null) => void }) {
  const [name, setName] = useState(current ?? "");
  const trimmed = name.trim();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-[13px] text-gray-700">
        <span className="sr-only">New name</span>
        <DenInput value={name} onChange={(event) => setName(event.target.value)} placeholder="A different name" maxLength={300} className="w-64" disabled={!editable} data-testid="config-rename-input" />
      </label>
      <DenButton size="sm" variant="secondary" disabled={!editable || trimmed === "" || trimmed === current} onClick={() => onRename(trimmed)}>Use this name</DenButton>
      {current ? <DenButton size="sm" variant="ghost" disabled={!editable} onClick={() => { setName(""); onRename(null); }}>Clear</DenButton> : null}
    </div>
  );
}

function FieldDiff({ fields, threeWay, closed }: { fields: ConfigFieldChange[]; threeWay: boolean; closed: boolean }) {
  const showBase = threeWay && fields.some((field) => field.base !== undefined);
  return (
    <table className="w-full table-fixed text-left text-[12px]">
      <thead className="text-gray-500">
        <tr>
          <th className="w-1/4 py-1 pr-3 font-medium">Field</th>
          {showBase ? <th className="py-1 pr-3 font-medium">When exported</th> : null}
          <th className="py-1 pr-3 font-medium">{closed ? "Before" : "Now"}</th>
          <th className="py-1 font-medium">{closed ? "After" : "In the file"}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {fields.map((field) => {
          const cells = formatFieldChange(field);
          return (
            <tr key={field.path} className={field.conflict ? "bg-[var(--dls-hover)]" : undefined} data-conflict={field.conflict ? "true" : undefined}>
              <td className="truncate py-1.5 pr-3 text-gray-700" title={field.path}>{formatFieldPath(field.path)}</td>
              {showBase ? <td className="break-words py-1.5 pr-3 text-gray-500">{formatFieldValue(field.base)}</td> : null}
              <td className="break-words py-1.5 pr-3 text-gray-500">{cells.now}</td>
              <td className="break-words py-1.5 text-gray-900">{cells.file}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
