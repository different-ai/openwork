"use client";

import {
  AUTO_ROUTER_MAX_MODELS,
  AUTO_ROUTER_MAX_TASKS_PER_MODEL,
  AUTO_ROUTER_NAME_MAX_LENGTH,
  AUTO_ROUTER_TASK_MAX_LENGTH,
  autoRouterModelName,
  autoRouterTaskKey,
  normalizeAutoRouterTaskName,
  type AutoRouter,
  type AutoRouterModelOption,
} from "@openwork/types/den/auto-router";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Plus, Sparkles, TriangleAlert, X } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenChipsCombobox } from "../../_components/ui/chips-combobox";
import { DenCombobox, type DenComboboxOption } from "../../_components/ui/combobox";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../_components/ui/tooltip";
import {
  getAiGatewayProvidersRoute,
  getAiGatewaySmartRouterRoute,
  getNewAiGatewaySmartRouterRoute,
  getOrgAccessFlags,
  permissionLockReason,
  type DenOrgMember,
  type DenOrgTeam,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { sameAccess, type AccessDraft } from "./access-summary";
import {
  accessGapSentence,
  accessToAssignment,
  assignmentToAccess,
  draftProblem,
  draftToWrite,
  membersWithoutAccess,
  mergeTasks,
  modelValue,
  reachedMemberIds,
  routerToDraft,
  sameModel,
  type ModelRef,
  type RouterDirectory,
  type RouterDraft,
  type RouterModelDraft,
} from "./auto-router-model";
import { useAutoRouterOptions, useAutoRouters, useDeleteAutoRouter, useSaveAutoRouter, useSaveAutoRouterAssignment } from "./auto-router-data";
import { AutoRouterSetupDialog } from "./auto-router-setup-dialog";
import { ConfirmDialog } from "./item-list";
import { providerIconSlug } from "./library-models";
import { WhoCanUseIt } from "./who-can-use-it";

const CARD = "rounded-[12px] border border-gray-100 bg-white p-4";
const CARD_TITLE = "text-[13px] font-medium text-gray-900";
const LOCK_REASON = permissionLockReason("gateway_providers.manage");
const EMPTY_ACCESS: AccessDraft = { orgWide: false, memberIds: [], teamIds: [] };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function findOption(options: readonly AutoRouterModelOption[], ref: ModelRef): AutoRouterModelOption | null {
  return options.find((option) => sameModel(option, ref)) ?? null;
}

/** The Smart Router mark, the size of a provider's brand mark. */
export function SmartRouterMark({ size = "md" }: { size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center border border-gray-100 bg-gray-50 text-gray-700 ${size === "sm" ? "h-5 w-5 rounded-[5px]" : "h-8 w-8 rounded-[8px]"}`}
    >
      <Sparkles size={size === "sm" ? 12 : 16} strokeWidth={1.5} />
    </span>
  );
}

function ModelMark({ name, logoProviderId }: { name: string; logoProviderId: string }) {
  return (
    <DenBrandMark
      name={name}
      simpleIconSlug={providerIconSlug(logoProviderId)}
      className="h-5 w-5 rounded-[5px] border-gray-200"
      imageClassName="h-3.5 w-3.5"
    />
  );
}

function AccessGapChip({ sentence }: { sentence: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" />}
        data-testid="auto-router-access-gap"
        className="flex h-[22px] shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 text-[11px] font-medium text-amber-800 outline-hidden focus-visible:ring-2 focus-visible:ring-amber-500/30"
      >
        <TriangleAlert size={12} strokeWidth={1.75} aria-hidden="true" />
        Not everyone has access
        <span className="sr-only">{`: ${sentence}`}</span>
      </TooltipTrigger>
      <TooltipContent>{sentence}</TooltipContent>
    </Tooltip>
  );
}

function ModelRowEditor({ row, index, options, takenValues, taskOptions, reached, directory, disabled, canRemove, onChange, onRemove, onTasksCreated }: {
  row: RouterModelDraft;
  index: number;
  options: readonly AutoRouterModelOption[];
  /** Models other rows already use. */
  takenValues: ReadonlySet<string>;
  taskOptions: readonly string[];
  /** The people the router applies to; empty while it applies to nobody. */
  reached: readonly string[];
  directory: RouterDirectory;
  disabled: boolean;
  canRemove: boolean;
  onChange: (next: RouterModelDraft) => void;
  onRemove: () => void;
  onTasksCreated: (tasks: string[]) => void;
}) {
  const option = row.model ? findOption(options, row.model) : null;
  const comboboxOptions: DenComboboxOption[] = options
    .filter((entry) => !takenValues.has(modelValue(entry)))
    .map((entry) => ({
      value: modelValue(entry),
      label: entry.modelName,
      description: entry.providerName,
      keywords: [entry.providerName, entry.modelId],
      icon: <ModelMark name={entry.providerName} logoProviderId={entry.logoProviderId} />,
    }));
  if (row.model && !option) {
    comboboxOptions.unshift({ value: modelValue(row.model), label: row.model.modelId, description: "No longer in the AI Gateway" });
  }
  const gap = option ? membersWithoutAccess(option.access, reached, directory) : [];
  const label = option?.modelName ?? row.model?.modelId ?? `Model ${index + 1}`;

  return (
    <li data-testid="auto-router-model-row" className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <DenCombobox
            ariaLabel={`Model ${index + 1}`}
            value={row.model ? modelValue(row.model) : ""}
            options={comboboxOptions}
            onChange={(value) => {
              const next = options.find((entry) => modelValue(entry) === value);
              if (next) onChange({ ...row, model: { providerId: next.providerId, modelId: next.modelId } });
            }}
            disabled={disabled}
            placeholder="Choose a model"
            searchPlaceholder="Search models"
            emptyLabel="No models match"
          />
        </div>
        {gap.length > 0 ? <AccessGapChip sentence={accessGapSentence(gap, directory)} /> : null}
        {row.model && !option ? <span className="shrink-0 text-[12px] text-gray-500">No longer in the AI Gateway</span> : null}
        <DenButton
          variant="ghost"
          size="xs"
          icon={X}
          aria-label={`Remove ${label}`}
          disabled={disabled || !canRemove}
          onClick={onRemove}
        />
      </div>
      <div className="flex items-start gap-3">
        <span className="w-12 shrink-0 pt-3 text-[13px] text-gray-500" aria-hidden="true">Tasks</span>
        <div className="min-w-0 flex-1">
          <DenChipsCombobox
            ariaLabel={`Tasks for ${label}`}
            value={row.tasks}
            options={taskOptions}
            query={row.pending}
            onQueryChange={(pending) => onChange({ ...row, pending })}
            onChange={(tasks) => {
              const created = tasks.filter((task) => !taskOptions.some((known) => autoRouterTaskKey(known) === autoRouterTaskKey(task)));
              if (created.length > 0) onTasksCreated(created);
              onChange({ ...row, tasks, pending: "" });
            }}
            toKey={autoRouterTaskKey}
            normalize={normalizeAutoRouterTaskName}
            maxItems={AUTO_ROUTER_MAX_TASKS_PER_MODEL}
            maxLength={AUTO_ROUTER_TASK_MAX_LENGTH}
            placeholder="Code review, quick questions"
            emptyLabel="Type a task and press Enter to add it."
            limitLabel={`Up to ${AUTO_ROUTER_MAX_TASKS_PER_MODEL} tasks per model`}
            disabled={disabled}
          />
        </div>
      </div>
    </li>
  );
}

/** Step one, or the details of a saved router: name, then models with their tasks. */
function DetailsCards({ draft, setDraft, options, optionsPending, optionsError, knownTasks, reached, directory, disabled }: {
  draft: RouterDraft;
  setDraft: (update: (current: RouterDraft) => RouterDraft) => void;
  options: readonly AutoRouterModelOption[];
  optionsPending: boolean;
  optionsError: React.ReactNode;
  knownTasks: readonly string[];
  reached: readonly string[];
  directory: RouterDirectory;
  disabled: boolean;
}) {
  const nameId = useId();
  const nextKey = useRef(0);
  /** Tasks typed in this editor that aren't saved yet: offered on every row. */
  const [sessionTasks, setSessionTasks] = useState<string[]>([]);
  const taskOptions = useMemo(
    () => mergeTasks(knownTasks, sessionTasks, ...draft.models.map((row) => row.tasks)),
    [knownTasks, sessionTasks, draft.models],
  );
  const allTaken = options.length > 0 && draft.models.filter((row) => row.model).length >= options.length;
  const atLimit = draft.models.length >= AUTO_ROUTER_MAX_MODELS;

  return (
    <>
      <section className={`${CARD} mt-5`} aria-labelledby={`${nameId}-heading`}>
        <h2 id={`${nameId}-heading`} className={CARD_TITLE}>Name</h2>
        <p className="mt-1 text-[12px] text-gray-500">Members see it in their model picker as {autoRouterModelName(draft.name.trim() || "<name>")}.</p>
        <DenInput
          id={nameId}
          aria-label="Name"
          className="mt-3"
          value={draft.name}
          maxLength={AUTO_ROUTER_NAME_MAX_LENGTH}
          disabled={disabled}
          placeholder="Engineering"
          data-testid="auto-router-name"
          onChange={(event) => { const name = event.target.value; setDraft((current) => ({ ...current, name })); }}
        />
      </section>

      <section className={`${CARD} mt-3`} aria-labelledby={`${nameId}-models`}>
        <div className="flex items-baseline justify-between gap-3">
          <h2 id={`${nameId}-models`} className={CARD_TITLE}>Models and tasks</h2>
          <span className="text-[12px] text-gray-500">If tasks tie, the first model answers.</span>
        </div>
        <p className="mt-1 text-[12px] text-gray-500">Each prompt goes to the model whose tasks fit it best. A task can be on more than one model.</p>
        {optionsError ? <div className="mt-3">{optionsError}</div> : null}
        {optionsPending ? (
          <div className="mt-3 flex flex-col gap-2" aria-hidden="true">
            <DenSkeleton className="h-[42px] w-full" />
            <DenSkeleton className="h-[42px] w-full" />
          </div>
        ) : (
          <ol aria-label="Models" className="mt-3 divide-y divide-gray-100">
            {draft.models.map((row, index) => (
              <ModelRowEditor
                key={row.key}
                row={row}
                index={index}
                options={options}
                takenValues={new Set(draft.models.flatMap((other) => (other.key !== row.key && other.model ? [modelValue(other.model)] : [])))}
                taskOptions={taskOptions}
                reached={reached}
                directory={directory}
                disabled={disabled}
                canRemove={draft.models.length > 1}
                onChange={(next) => setDraft((current) => ({ ...current, models: current.models.map((entry) => (entry.key === row.key ? next : entry)) }))}
                onRemove={() => setDraft((current) => ({ ...current, models: current.models.filter((entry) => entry.key !== row.key) }))}
                onTasksCreated={(created) => setSessionTasks((current) => mergeTasks(current, created))}
              />
            ))}
          </ol>
        )}
        <DenButton
          className="mt-3"
          variant="secondary"
          size="sm"
          icon={Plus}
          data-testid="auto-router-add-model"
          disabled={disabled || optionsPending || atLimit || allTaken}
          title={atLimit ? `Up to ${AUTO_ROUTER_MAX_MODELS} models` : allTaken ? "Every AI Gateway model is in this router" : undefined}
          onClick={() => setDraft((current) => ({ ...current, models: [...current.models, { key: `added-${nextKey.current++}`, model: null, tasks: [], pending: "" }] }))}
        >
          Add model
        </DenButton>
      </section>
    </>
  );
}

function WhoCanUseItCard({ access, onChange, directory, canShareWithEveryone, disabled }: {
  access: AccessDraft;
  onChange: (next: AccessDraft) => void;
  directory: { members: readonly DenOrgMember[]; teams: readonly DenOrgTeam[] };
  canShareWithEveryone: boolean;
  disabled: boolean;
}) {
  return (
    <section className={`${CARD} mt-3`} aria-labelledby="auto-router-access-heading" data-testid="auto-router-access">
      <h2 id="auto-router-access-heading" className={CARD_TITLE}>Who can use it</h2>
      <p className="mb-3 mt-1 text-[12px] text-gray-500">People it applies to get it in their desktop model picker, as long as they can use at least one of its models.</p>
      <WhoCanUseIt
        value={access}
        onChange={onChange}
        members={directory.members}
        teams={directory.teams}
        owner={null}
        canShareWithEveryone={canShareWithEveryone}
        everyoneOffDescription={access.memberIds.length === 0 && access.teamIds.length === 0
          ? "Off. Nobody has it yet."
          : "Off. Only the people and teams below have it."}
        disabled={disabled}
      />
    </section>
  );
}

/** Step two's view of the models: who can't use which. */
function ModelAccessCard({ router, options, reached, directory }: {
  router: AutoRouter;
  options: readonly AutoRouterModelOption[];
  reached: readonly string[];
  directory: RouterDirectory;
}) {
  return (
    <section className={`${CARD} mt-3`} aria-labelledby="auto-router-model-access-heading">
      <h2 id="auto-router-model-access-heading" className={CARD_TITLE}>Models</h2>
      <ul className="mt-2 divide-y divide-gray-100">
        {router.models.map((model) => {
          const option = findOption(options, model);
          const gap = option ? membersWithoutAccess(option.access, reached, directory) : [];
          return (
            <li key={model.id} className="flex items-center gap-3 py-2.5" data-testid="auto-router-model-access">
              {option ? <ModelMark name={option.providerName} logoProviderId={option.logoProviderId} /> : <SmartRouterMark size="sm" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-gray-900">{option?.modelName ?? model.modelId}</span>
                <span className="block truncate text-[12px] text-gray-500">{model.tasks.join(", ")}</span>
              </span>
              {gap.length > 0 ? <AccessGapChip sentence={accessGapSentence(gap, directory)} /> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Steps({ step }: { step: 1 | 2 }) {
  const items = ["Models and tasks", "Who can use it"];
  return (
    <ol aria-label="Steps" className="mt-4 flex items-center gap-3 text-[12px]" data-testid="auto-router-steps">
      {items.map((label, index) => {
        const number = index + 1;
        const done = number < step;
        const current = number === step;
        return (
          <li key={label} aria-current={current ? "step" : undefined} className={`flex items-center gap-2 ${current ? "font-medium text-gray-900" : "text-gray-500"}`}>
            <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${current ? "bg-gray-900 text-white" : done ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>
              {done ? <Check size={12} strokeWidth={2} aria-hidden="true" /> : number}
            </span>
            {label}
            {number < items.length ? <span className="ml-1 h-px w-6 bg-gray-200" aria-hidden="true" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * A Smart Router's page, shown like a provider's under AI Providers.
 * - No router id: step one of creating one (name, models, tasks). Continue
 *   creates it, applying to nobody, and opens step two.
 * - `step="access"`: step two, who it applies to.
 * - Otherwise: the router's details and who can use it, saved together.
 */
export function AutoRouterScreen({ routerId, step }: { routerId?: string; step?: "access" }) {
  const navigation = useRouter();
  const { orgId: scopedOrgId, orgSlug, orgContext } = useOrgDashboard();
  const orgId = scopedOrgId ?? "";
  const routers = useAutoRouters(orgId);
  const options = useAutoRouterOptions(orgId);
  const saveDetails = useSaveAutoRouter(orgId);
  const saveAssignment = useSaveAutoRouterAssignment(orgId);
  const remove = useDeleteAutoRouter(orgId);
  const [error, setError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const directory = useMemo(
    () => ({ members: orgContext?.members ?? [], teams: orgContext?.teams ?? [] }),
    [orgContext?.members, orgContext?.teams],
  );
  const canShareWithEveryone = orgContext
    ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions).canShareWithEveryone
    : false;

  const router = routerId ? routers.data?.routers.find((entry) => entry.id === routerId) ?? null : null;
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [draft, setDraftState] = useState<RouterDraft>(() => routerToDraft(null, () => "row-0"));
  const [access, setAccess] = useState<AccessDraft>(EMPTY_ACCESS);
  // Load the saved router into the editor once it arrives (and again if another one opens).
  if (router && loadedId !== router.id) {
    let index = 0;
    setLoadedId(router.id);
    setDraftState(routerToDraft(router, () => `row-${index++}`));
    setAccess(assignmentToAccess(router.assignment));
  }
  const setDraft = (update: (current: RouterDraft) => RouterDraft) => setDraftState(update);

  const modelOptions = options.data?.options ?? [];
  const reached = useMemo(() => reachedMemberIds(accessToAssignment(access), directory), [access, directory]);
  const list = routers.data;
  const canEdit = list?.canEdit ?? false;
  const missingKey = list?.routing === "missing_key";
  const busy = saveDetails.isPending || saveAssignment.isPending || remove.isPending;
  const locked = !canEdit || missingKey;
  const providersRoute = getAiGatewayProvidersRoute(orgSlug);
  const optionsError = options.isError ? (
    <DenNotice
      tone="error"
      message={errorMessage(options.error, "Couldn't load your AI Gateway models.")}
      action={<DenButton variant="secondary" size="sm" loading={options.isFetching} onClick={() => void options.refetch()}>Try again</DenButton>}
    />
  ) : null;

  const breadcrumb = (current: string) => (
    <nav className="text-[12px] text-gray-500" aria-label="Breadcrumb">
      <Link href={providersRoute} className="hover:text-gray-900">AI Providers</Link>
      <span className="mx-1.5 text-gray-500" aria-hidden="true">/</span>
      <span className="text-gray-900">{current}</span>
    </nav>
  );

  if (routers.isPending || (routerId && !router && routers.isFetching)) {
    return (
      <div aria-busy="true" aria-label="Loading Smart Router" className="flex flex-col gap-3">
        <DenSkeleton className="h-4 w-40" />
        <DenSkeleton className="mb-2 h-7 w-48" />
        {[0, 1].map((index) => <div key={index} className={CARD}><DenSkeleton className="h-4 w-24" /><DenSkeleton className="mt-3 h-8 w-full" /></div>)}
      </div>
    );
  }
  if (routers.isError || (routerId && !router)) {
    return (
      <div>
        {breadcrumb("Smart Router")}
        <DenNotice
          className="mt-4"
          tone="error"
          message={routers.isError ? errorMessage(routers.error, "Couldn't load Smart Routers.") : "This Smart Router doesn't exist anymore. Return to AI Providers."}
          action={<DenButton size="sm" variant="secondary" onClick={() => void routers.refetch()}>Retry</DenButton>}
        />
      </div>
    );
  }

  const notices = (
    <>
      {missingKey ? (
        <div data-testid="auto-router-paused">
          <DenNotice
            className="mt-4"
            tone="warning"
            message="Smart routing is paused: the AI Gateway is missing its routing key, so members don't see Smart models and routers can't be changed."
            action={<DenButton variant="secondary" size="sm" data-testid="auto-router-setup-open" onClick={() => setSetupOpen(true)}>How to fix</DenButton>}
          />
        </div>
      ) : null}
      {!canEdit ? <DenNotice className="mt-4" tone="neutral" message={`Read only. ${LOCK_REASON}`} /> : null}
      {error ? <DenNotice tone="error" message={error} className="mt-4" /> : null}
    </>
  );
  const setupDialog = <AutoRouterSetupDialog open={setupOpen} onOpenChange={setSetupOpen} />;

  async function createRouter() {
    setError(null);
    const known = list?.tasks ?? [];
    const problem = draftProblem(draft, known);
    const input = draftToWrite(draft, known);
    if (problem || !input) { setError(problem ?? "Check the Smart Router and try again."); return; }
    try {
      const result = await saveDetails.mutateAsync({ routerId: null, input });
      if (result?.routerId) navigation.push(getAiGatewaySmartRouterRoute(orgSlug, result.routerId, "access"));
      else navigation.push(providersRoute);
    } catch (cause) {
      setError(errorMessage(cause, "Couldn't create the Smart Router. Try again."));
    }
  }

  async function saveAccess(target: AutoRouter) {
    setError(null);
    try {
      await saveAssignment.mutateAsync({ routerId: target.id, assignment: accessToAssignment(access) });
      navigation.push(providersRoute);
    } catch (cause) {
      setError(errorMessage(cause, "Couldn't save who can use it. Try again."));
    }
  }

  async function saveAll(target: AutoRouter) {
    setError(null);
    const known = list?.tasks ?? [];
    const problem = draftProblem(draft, known);
    const input = draftToWrite(draft, known);
    if (problem || !input) { setError(problem ?? "Check the Smart Router and try again."); return; }
    try {
      await saveDetails.mutateAsync({ routerId: target.id, input });
      if (!sameAccess(access, assignmentToAccess(target.assignment))) {
        await saveAssignment.mutateAsync({ routerId: target.id, assignment: accessToAssignment(access) });
      }
      navigation.push(providersRoute);
    } catch (cause) {
      setError(errorMessage(cause, "Couldn't save the Smart Router. Try again."));
    }
  }

  // Step one: a new router's name, models and tasks.
  if (!router) {
    return (
      <div className="pb-28" data-testid="auto-router-editor" data-step="details">
        {breadcrumb("Add a Smart Router")}
        <div className="mt-3 flex items-center gap-3">
          <SmartRouterMark />
          <h2 className="text-[20px] font-medium tracking-[-0.02em] text-gray-900">Add a Smart Router</h2>
        </div>
        <Steps step={1} />
        {notices}
        <DetailsCards
          draft={draft}
          setDraft={setDraft}
          options={modelOptions}
          optionsPending={options.isPending}
          optionsError={optionsError}
          knownTasks={list?.tasks ?? []}
          reached={[]}
          directory={directory}
          disabled={busy || locked}
        />
        <DenStickyActionBar summary={<span>Step 1 of 2 · {draft.models.length === 1 ? "1 model" : `${draft.models.length} models`}</span>}>
          <Link href={providersRoute} className={buttonVariants({ variant: "secondary" })}>Cancel</Link>
          <DenButton data-testid="auto-router-save" loading={saveDetails.isPending} disabled={locked} onClick={() => void createRouter()}>Continue</DenButton>
        </DenStickyActionBar>
        {setupDialog}
      </div>
    );
  }

  const title = autoRouterModelName(router.name);

  // Step two: who the new router applies to.
  if (step === "access") {
    return (
      <div className="pb-28" data-testid="auto-router-editor" data-step="access">
        {breadcrumb(title)}
        <div className="mt-3 flex items-center gap-3">
          <SmartRouterMark />
          <h2 className="text-[20px] font-medium tracking-[-0.02em] text-gray-900">{title}</h2>
        </div>
        <Steps step={2} />
        {notices}
        <WhoCanUseItCard access={access} onChange={setAccess} directory={directory} canShareWithEveryone={canShareWithEveryone} disabled={busy || !canEdit} />
        <ModelAccessCard router={router} options={modelOptions} reached={reached} directory={directory} />
        <DenStickyActionBar summary={<span>Step 2 of 2 · {access.orgWide ? "everyone" : `${reached.length === 1 ? "1 person" : `${reached.length} people`}`}</span>}>
          <Link href={providersRoute} className={buttonVariants({ variant: "secondary" })} data-testid="auto-router-skip">Skip for now</Link>
          <DenButton data-testid="auto-router-save-access" loading={saveAssignment.isPending} disabled={!canEdit} onClick={() => void saveAccess(router)}>Save</DenButton>
        </DenStickyActionBar>
        {setupDialog}
      </div>
    );
  }

  // A saved router: its details and who can use it, saved together.
  return (
    <div className="pb-28" data-testid="auto-router-editor" data-step="manage">
      {breadcrumb(title)}
      <div className="mt-3 flex items-center gap-3">
        <SmartRouterMark />
        <h2 className="text-[20px] font-medium tracking-[-0.02em] text-gray-900">{title}</h2>
      </div>
      {notices}
      <DetailsCards
        draft={draft}
        setDraft={setDraft}
        options={modelOptions}
        optionsPending={options.isPending}
        optionsError={optionsError}
        knownTasks={list?.tasks ?? []}
        reached={reached}
        directory={directory}
        disabled={busy || locked}
      />
      <WhoCanUseItCard access={access} onChange={setAccess} directory={directory} canShareWithEveryone={canShareWithEveryone} disabled={busy || locked} />
      <DenStickyActionBar summary={<span>{draft.models.length === 1 ? "1 model" : `${draft.models.length} models`} · {access.orgWide ? "everyone" : `${reached.length === 1 ? "1 person" : `${reached.length} people`}`}</span>}>
        {canEdit ? (
          <DenButton variant="secondary" data-testid="auto-router-delete" disabled={busy} onClick={() => setConfirmDelete(true)}>Remove</DenButton>
        ) : (
          <Link href={providersRoute} className={buttonVariants({ variant: "secondary" })}>Back</Link>
        )}
        <DenButton data-testid="auto-router-save" loading={saveDetails.isPending || saveAssignment.isPending} disabled={locked} onClick={() => void saveAll(router)}>Save changes</DenButton>
      </DenStickyActionBar>
      <ConfirmDialog
        destructive
        confirm={confirmDelete ? {
          title: `Remove ${title}?`,
          description: `People it applies to lose ${title} in the desktop. This cannot be undone.`,
          action: "Remove",
        } : null}
        onConfirm={async () => {
          await remove.mutateAsync(router.id);
          navigation.push(providersRoute);
        }}
        onClose={() => setConfirmDelete(false)}
      />
      {setupDialog}
    </div>
  );
}

/** The "Add a Smart Router" button beside "Add a provider". Without the routing key it opens the setup steps instead. */
export function AddSmartRouterButton({ missingKey }: { missingKey: boolean }) {
  const { orgSlug } = useOrgDashboard();
  const [setupOpen, setSetupOpen] = useState(false);
  if (missingKey) {
    return (
      <>
        <DenButton
          size="sm"
          variant="secondary"
          icon={Sparkles}
          data-testid="auto-router-new"
          data-blocked="missing-key"
          title="Needs a routing key on the AI Gateway"
          onClick={() => setSetupOpen(true)}
        >
          Add a Smart Router
        </DenButton>
        <AutoRouterSetupDialog open={setupOpen} onOpenChange={setSetupOpen} />
      </>
    );
  }
  return (
    <Link href={getNewAiGatewaySmartRouterRoute(orgSlug)} data-testid="auto-router-new" className={buttonVariants({ variant: "secondary", size: "sm" })}>
      <Sparkles className="h-4 w-4" aria-hidden="true" />
      Add a Smart Router
    </Link>
  );
}
