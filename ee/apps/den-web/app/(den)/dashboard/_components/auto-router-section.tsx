"use client";

import {
  AUTO_ROUTER_MAX_MODELS,
  AUTO_ROUTER_MAX_ROUTERS,
  AUTO_ROUTER_MAX_TASKS_PER_MODEL,
  AUTO_ROUTER_NAME_MAX_LENGTH,
  AUTO_ROUTER_TASK_MAX_LENGTH,
  autoRouterModelName,
  autoRouterTaskKey,
  normalizeAutoRouterTaskName,
  type AutoRouter,
  type AutoRouterList,
  type AutoRouterModelOption,
} from "@openwork/types/den/auto-router";
import Link from "next/link";
import { Lock, Pencil, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenChipsCombobox } from "../../_components/ui/chips-combobox";
import { DenCombobox, type DenComboboxOption } from "../../_components/ui/combobox";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../_components/ui/tooltip";
import { getNewAiGatewayProviderRoute, getOrgAccessFlags, permissionLockReason } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  accessGapSentence,
  accessToAssignment,
  assignmentSummary,
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
import { useAutoRouterOptions, useAutoRouters, useDeleteAutoRouter, useSaveAutoRouter } from "./auto-router-data";
import { AutoRouterSetupDialog } from "./auto-router-setup-dialog";
import { SectionTitle } from "./item-header";
import { ConfirmDialog } from "./item-list";
import { providerIconSlug } from "./library-models";
import { WhoCanUseIt } from "./who-can-use-it";

const LOCK_REASON = permissionLockReason("gateway_providers.manage");
const MISSING_KEY_REASON = "Needs a routing key on the AI Gateway";

/** null: the list. `routerId: null`: a new router. */
type EditorTarget = { routerId: string | null } | null;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function findOption(options: readonly AutoRouterModelOption[], ref: ModelRef): AutoRouterModelOption | null {
  return options.find((option) => sameModel(option, ref)) ?? null;
}

function countLabel(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

function ModelMark({ name, logoProviderId, small = false }: { name: string; logoProviderId: string; small?: boolean }) {
  return (
    <DenBrandMark
      name={name}
      simpleIconSlug={providerIconSlug(logoProviderId)}
      className={small ? "h-5 w-5 rounded-[5px] border-gray-200 bg-white" : "h-5 w-5 rounded-[5px] border-gray-200"}
      imageClassName="h-3.5 w-3.5"
    />
  );
}

/* ------------------------------------------------------------------ list */

function RouterRow({ router, options, directory, canEdit, missingKey, onEdit, onDelete }: {
  router: AutoRouter;
  options: readonly AutoRouterModelOption[];
  directory: RouterDirectory;
  canEdit: boolean;
  missingKey: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const marks = router.models.slice(0, 4).map((model) => {
    const option = findOption(options, model);
    return { key: model.id, name: option?.providerName ?? model.providerId, logo: option?.logoProviderId ?? model.providerId };
  });
  return (
    <li data-testid="auto-router-row" data-router-id={router.id} className="flex min-h-[56px] items-center gap-3 px-4 py-2.5">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[14px] font-medium leading-5 text-gray-900">{router.name}</span>
        <span className="truncate text-[12px] leading-4 text-gray-500">{assignmentSummary(router.assignment, directory)}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2 text-[12px] text-gray-500">
        <span className="flex -space-x-1" aria-hidden="true">
          {marks.map((mark) => <ModelMark key={mark.key} small name={mark.name} logoProviderId={mark.logo} />)}
        </span>
        <span>{countLabel(router.models.length, "model", "models")}</span>
      </span>
      {canEdit ? (
        <span className="flex shrink-0 items-center gap-1">
          <DenButton
            variant="ghost"
            size="xs"
            icon={Pencil}
            aria-label={`Edit ${router.name}`}
            title={missingKey ? MISSING_KEY_REASON : undefined}
            data-blocked={missingKey ? "missing-key" : undefined}
            className={missingKey ? "opacity-60" : undefined}
            onClick={onEdit}
          />
          <DenButton variant="ghost" size="xs" icon={Trash2} aria-label={`Delete ${router.name}`} onClick={onDelete} />
        </span>
      ) : null}
    </li>
  );
}

function ListSkeleton() {
  return (
    <section aria-label="Smart Model Router" aria-busy="true" data-testid="auto-router-section">
      <div className="flex min-h-9 items-center justify-between pb-1.5" aria-hidden="true">
        <DenSkeleton className="h-4 w-32" />
        <DenSkeleton className="h-8 w-36 rounded-lg" />
      </div>
      <div className="divide-y divide-gray-100 rounded-[12px] border border-gray-100 bg-white" aria-hidden="true">
        {[0, 1].map((index) => (
          <div key={index} className="flex min-h-[56px] items-center gap-3 px-4 py-2.5">
            <span className="flex flex-1 flex-col gap-1.5"><DenSkeleton className="h-4 w-40" /><DenSkeleton className="h-3 w-24" /></span>
            <DenSkeleton className="h-5 w-20" />
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- editor */

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
    <li data-testid="auto-router-model-row" className="flex flex-col gap-2 px-4 py-3">
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

function RouterEditor({ router, list, options, optionsPending, optionsError, directory, canShareWithEveryone, onDone }: {
  router: AutoRouter | null;
  list: AutoRouterList;
  options: readonly AutoRouterModelOption[];
  optionsPending: boolean;
  optionsError: ReactNode;
  directory: RouterDirectory;
  canShareWithEveryone: boolean;
  onDone: () => void;
}) {
  const { orgId: scopedOrgId, orgContext } = useOrgDashboard();
  const orgId = scopedOrgId ?? "";
  const save = useSaveAutoRouter(orgId);
  const nameId = useId();
  const nextKey = useRef(0);
  const newKey = () => `row-${nextKey.current++}`;
  const [draft, setDraft] = useState<RouterDraft>(() => routerToDraft(router, newKey, canShareWithEveryone));
  /** Tasks typed in this editor that aren't saved yet: offered on every row. */
  const [sessionTasks, setSessionTasks] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const taskOptions = useMemo(
    () => mergeTasks(list.tasks, sessionTasks, ...draft.models.map((row) => row.tasks)),
    [list.tasks, sessionTasks, draft.models],
  );
  const reached = useMemo(() => reachedMemberIds(accessToAssignment(draft.access), directory), [draft.access, directory]);
  const busy = save.isPending;
  const allTaken = options.length > 0 && draft.models.filter((row) => row.model).length >= options.length;
  const atLimit = draft.models.length >= AUTO_ROUTER_MAX_MODELS;

  function updateRow(key: string, next: RouterModelDraft) {
    setDraft((current) => ({ ...current, models: current.models.map((row) => (row.key === key ? next : row)) }));
  }

  async function submit() {
    setError(null);
    const problem = draftProblem(draft, taskOptions);
    const input = draftToWrite(draft, taskOptions);
    if (problem || !input) { setError(problem ?? "Check the Smart Router and try again."); return; }
    try {
      await save.mutateAsync({ routerId: router?.id ?? null, input });
      onDone();
    } catch (cause) {
      setError(errorMessage(cause, "Couldn't save the Smart Router. Try again."));
    }
  }

  return (
    <section aria-label={router ? `Edit ${router.name}` : "New Smart Router"} data-testid="auto-router-editor" className="flex flex-col gap-6">
      <h2 className="text-[16px] font-semibold leading-6 tracking-[-0.01em] text-gray-950">{router ? router.name : "New Smart Router"}</h2>

      <div className="flex flex-col gap-2.5">
        <SectionTitle title="Who it applies to" meta={draft.access.orgWide ? undefined : countLabel(reached.length, "person", "people")} />
        <WhoCanUseIt
          value={draft.access}
          onChange={(access) => setDraft((current) => ({ ...current, access }))}
          members={orgContext?.members ?? []}
          teams={orgContext?.teams ?? []}
          owner={null}
          canShareWithEveryone={canShareWithEveryone}
          everyoneOffDescription={draft.access.memberIds.length === 0 && draft.access.teamIds.length === 0
            ? "Off. Nobody has it yet."
            : "Off. Only the people and teams below have it."}
          disabled={busy}
        />
      </div>

      <div className="flex flex-col gap-2.5">
        <label htmlFor={nameId} className="text-[15px] font-semibold leading-5 text-gray-900">Name</label>
        <DenInput
          id={nameId}
          value={draft.name}
          maxLength={AUTO_ROUTER_NAME_MAX_LENGTH}
          disabled={busy}
          placeholder="Engineering"
          data-testid="auto-router-name"
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
        />
      </div>

      <div className="flex flex-col gap-2.5">
        <SectionTitle title="Models" meta="If tasks tie, the first model answers." />
        {optionsError}
        {optionsPending ? (
          <div className="flex flex-col gap-2 rounded-[12px] border border-gray-100 bg-white px-4 py-3" aria-hidden="true">
            <DenSkeleton className="h-[42px] w-full" />
            <DenSkeleton className="h-[42px] w-full" />
          </div>
        ) : (
          <ol aria-label="Models" className="divide-y divide-gray-100 rounded-[12px] border border-gray-100 bg-white">
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
                disabled={busy}
                canRemove={draft.models.length > 1}
                onChange={(next) => updateRow(row.key, next)}
                onRemove={() => setDraft((current) => ({ ...current, models: current.models.filter((entry) => entry.key !== row.key) }))}
                onTasksCreated={(created) => setSessionTasks((current) => mergeTasks(current, created))}
              />
            ))}
          </ol>
        )}
        <div>
          <DenButton
            variant="secondary"
            size="sm"
            icon={Plus}
            data-testid="auto-router-add-model"
            disabled={busy || optionsPending || atLimit || allTaken}
            title={atLimit ? `Up to ${AUTO_ROUTER_MAX_MODELS} models` : allTaken ? "Every AI Gateway model is in this router" : undefined}
            onClick={() => setDraft((current) => ({ ...current, models: [...current.models, { key: newKey(), model: null, tasks: [], pending: "" }] }))}
          >
            Add model
          </DenButton>
        </div>
      </div>

      {error ? <DenNotice tone="error" message={error} /> : null}

      <div className="flex items-center justify-end gap-2 border-t border-gray-100 pt-4">
        <DenButton variant="secondary" size="sm" disabled={busy} onClick={onDone}>Cancel</DenButton>
        <DenButton size="sm" data-testid="auto-router-save" loading={busy} onClick={() => void submit()}>
          {router ? "Save changes" : "Create Smart Router"}
        </DenButton>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- section */

/** AI Gateway › Smart Model Router: the organization's Smart Routers, who each applies to, and its models with their tasks. */
export function AutoRouterSection() {
  const { orgId: scopedOrgId, orgSlug, orgContext } = useOrgDashboard();
  const orgId = scopedOrgId ?? "";
  const routers = useAutoRouters(orgId);
  const options = useAutoRouterOptions(orgId);
  const remove = useDeleteAutoRouter(orgId);
  const [editor, setEditor] = useState<EditorTarget>(null);
  const [deleting, setDeleting] = useState<AutoRouter | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const missingKeyId = useId();

  const directory: RouterDirectory = useMemo(
    () => ({ members: orgContext?.members ?? [], teams: orgContext?.teams ?? [] }),
    [orgContext?.members, orgContext?.teams],
  );
  const canShareWithEveryone = orgContext
    ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions).canShareWithEveryone
    : false;

  if (routers.isPending) return <ListSkeleton />;

  if (routers.isError) {
    return (
      <section aria-label="Smart Model Router" data-testid="auto-router-section">
        <DenNotice
          tone="error"
          message={errorMessage(routers.error, "Couldn't load Smart Routers.")}
          action={<DenButton variant="secondary" size="sm" loading={routers.isFetching} onClick={() => void routers.refetch()}>Try again</DenButton>}
        />
      </section>
    );
  }

  const list = routers.data;
  const { canEdit, routing } = list;
  const missingKey = routing === "missing_key";
  const modelOptions = options.data?.options ?? [];
  const noModels = options.data !== undefined && modelOptions.length === 0;
  const atLimit = list.routers.length >= AUTO_ROUTER_MAX_ROUTERS;
  const setupDialog = <AutoRouterSetupDialog open={setupOpen} onOpenChange={setSetupOpen} />;
  const optionsError = options.isError ? (
    <DenNotice
      tone="error"
      message={errorMessage(options.error, "Couldn't load your AI Gateway models.")}
      action={<DenButton variant="secondary" size="sm" loading={options.isFetching} onClick={() => void options.refetch()}>Try again</DenButton>}
    />
  ) : null;

  function openEditor(routerId: string | null) {
    // Without the gateway's routing key routers can't be saved: explain how to add it instead.
    if (missingKey) { setSetupOpen(true); return; }
    setEditor({ routerId });
  }

  if (editor && canEdit && !missingKey) {
    const router = editor.routerId ? list.routers.find((entry) => entry.id === editor.routerId) ?? null : null;
    return (
      <RouterEditor
        key={editor.routerId ?? "new"}
        router={router}
        list={list}
        options={modelOptions}
        optionsPending={options.isPending}
        optionsError={optionsError}
        directory={directory}
        canShareWithEveryone={canShareWithEveryone}
        onDone={() => setEditor(null)}
      />
    );
  }

  const addProviderLink = (
    <Link href={getNewAiGatewayProviderRoute(orgSlug)} className={buttonVariants({ variant: "secondary", size: "sm" })}>
      Add a provider
    </Link>
  );
  const newButton = !canEdit ? (
    <DenButton size="sm" icon={Lock} variant="secondary" disabled title={LOCK_REASON} data-testid="auto-router-new">New Smart Router</DenButton>
  ) : noModels ? addProviderLink : (
    <DenButton
      size="sm"
      icon={Plus}
      data-testid="auto-router-new"
      // Muted and explained rather than inert: the click opens the setup steps.
      variant={missingKey ? "secondary" : undefined}
      data-blocked={missingKey ? "missing-key" : undefined}
      aria-describedby={missingKey ? missingKeyId : undefined}
      disabled={atLimit}
      title={atLimit ? `Up to ${AUTO_ROUTER_MAX_ROUTERS} Smart Routers` : undefined}
      onClick={() => openEditor(null)}
    >
      New Smart Router
    </DenButton>
  );
  const notes = (
    <>
      {canEdit && noModels ? <p className="mt-2 px-1 text-[13px] text-gray-500">Add a provider and its models to the AI Gateway first.</p> : null}
      {canEdit && !noModels && missingKey ? (
        <p id={missingKeyId} data-testid="auto-router-missing-key" className="mt-2 px-1 text-[13px] text-gray-500">{MISSING_KEY_REASON}</p>
      ) : null}
      {canEdit ? null : (
        <p className="mt-3 flex items-center gap-2 px-1 text-[13px] text-gray-500">
          <Lock size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
          {`Read only. ${LOCK_REASON}`}
        </p>
      )}
    </>
  );

  if (list.routers.length === 0) {
    return (
      <section aria-label="Smart Model Router" data-testid="auto-router-section" data-state="empty">
        <div className="flex flex-col items-start gap-4 rounded-[12px] border border-gray-100 bg-white px-5 py-5">
          <p className="max-w-xl text-[13px] leading-5 text-gray-600">
            Members pick &ldquo;Smart: &lt;name&gt;&rdquo; in the desktop, and each prompt goes to the model whose tasks fit it best.
            Smart also decides how much the model thinks.
          </p>
          {newButton}
        </div>
        {notes}
        {setupDialog}
      </section>
    );
  }

  return (
    <section aria-label="Smart Model Router" data-testid="auto-router-section" data-state="list">
      {optionsError ? <div className="mb-3">{optionsError}</div> : null}
      {missingKey ? (
        <div data-testid="auto-router-paused">
          <DenNotice
            className="mb-3"
            tone="warning"
            message="Smart routing is paused: the AI Gateway is missing its routing key, so members don't see their Smart models. Routers can't be changed until it's added."
            action={canEdit ? <DenButton variant="secondary" size="sm" data-testid="auto-router-setup-open" onClick={() => setSetupOpen(true)}>How to fix</DenButton> : undefined}
          />
        </div>
      ) : null}

      <div className="flex min-h-9 items-center justify-between gap-3 pb-1.5">
        <span className="flex items-center gap-2">
          <h2 className="text-[14px] font-medium text-gray-900">Smart Routers</h2>
          <span className="text-[12px] text-gray-500">{list.routers.length}</span>
        </span>
        {newButton}
      </div>

      <ul aria-label="Smart Routers" className="divide-y divide-gray-100 overflow-hidden rounded-[12px] border border-gray-100 bg-white">
        {list.routers.map((router) => (
          <RouterRow
            key={router.id}
            router={router}
            options={modelOptions}
            directory={directory}
            canEdit={canEdit}
            missingKey={missingKey}
            onEdit={() => openEditor(router.id)}
            onDelete={() => setDeleting(router)}
          />
        ))}
      </ul>
      {notes}

      <ConfirmDialog
        destructive
        confirm={deleting ? {
          title: `Delete ${deleting.name}?`,
          description: `People it applies to lose ${autoRouterModelName(deleting.name)} in the desktop. This cannot be undone.`,
          action: "Delete",
        } : null}
        onConfirm={async () => { if (deleting) await remove.mutateAsync(deleting.id); }}
        onClose={() => setDeleting(null)}
      />
      {setupDialog}
    </section>
  );
}
