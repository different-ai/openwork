"use client";

import { Popover } from "@base-ui/react/popover";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ACTIVATION_STEP_TITLES,
  activationChecklistPresentation,
  activationProgress,
  activationStateSchema,
  nextActivationStep,
  orderedActivationSteps,
  type ActivationState,
  type ActivationStep,
} from "@openwork/types/den/activation";
import { Check, ExternalLink, Lock, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useWorkbotConnect, WorkbotConnectionButton } from "./connect";
import type { WorkbotConnection, WorkbotTurn } from "./data";
import { workbotHost } from "./host";

/**
 * The "Get set up" chip in Workbot's header: the same six steps, in the same order, as
 * Desktop's sidebar card. Den computes every step; Workbot only reports its first answer and hiding the checklist.
 * Nothing shows before the first answer or after all six are done.
 */

/** An answer to something the person asked (not Workbot's own hello) finished. */
export function hasAnsweredTurn(turns: readonly Pick<WorkbotTurn, "greeting" | "status">[] | undefined): boolean {
  return Boolean(turns?.some((turn) => !turn.greeting && turn.status === "done"));
}

const reported = new Set<string>();
/** Once per person and workspace per page: Den ignores repeats, but there is no reason to send them. */
export function claimActivationReport(key: string): boolean {
  if (reported.has(key)) return false;
  reported.add(key);
  return true;
}

/** Den pages a step opens in a new tab, in the workspace Workbot is signed in to. */
const DEN_PAGES = {
  invite_teammate: "members",
  use_skill: "library?show=skills",
  own_provider: "library/model-providers/new",
  gateway_provider: "ai-gateway?tab=ai-providers",
  connector: "library?show=connectors",
} as const;

export function activationDenUrl(destination: { denUrl: string; organizationId: string }, step: keyof typeof DEN_PAGES): string {
  const path = DEN_PAGES[step];
  // Scan the suffix once: an unanchored trailing-slash regex can backtrack quadratically.
  let end = destination.denUrl.length;
  while (end > 0 && destination.denUrl[end - 1] === "/") end -= 1;
  return `${destination.denUrl.slice(0, end)}/dashboard/${path}${path.includes("?") ? "&" : "?"}workbotOrganizationId=${encodeURIComponent(destination.organizationId)}`;
}

function activationKey() {
  const host = workbotHost();
  return ["workbot", "activation", host.identity?.principalId, host.identity?.organizationId] as const;
}

function useWorkbotActivation() {
  const host = workbotHost();
  return useQuery({
    queryKey: activationKey(),
    enabled: Boolean(host.activation && host.identity && host.documentAuthorization === undefined),
    queryFn: async (): Promise<ActivationState | null> => {
      const { response, payload } = await host.requestJson("/v1/workbot/activation", { method: "GET" }, 15_000);
      // Off for this workspace (or an older Den): no checklist.
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Couldn't check your setup.");
      return activationStateSchema.parse(payload);
    },
    staleTime: 15_000,
    refetchOnWindowFocus: "always",
    retry: false,
  });
}

const chipClass = "flex h-7 items-center gap-1.5 rounded-full bg-[var(--wb-chip)] px-2.5 text-[12px] font-medium leading-4 text-[var(--wb-text)] transition-colors duration-150 hover:bg-[var(--wb-bubble)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";
const actionClass = "inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-3 text-[12px] font-medium text-[var(--wb-text)] shadow-[0_0_0_1px_var(--wb-ring)] transition-colors duration-150 hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";

function rowState(step: ActivationStep): "done" | "locked" | "open" {
  return step.done ? "done" : step.lockedReason ? "locked" : "open";
}

function StepMark({ state }: { state: "done" | "locked" | "open" }) {
  if (state === "done") return <span className="grid size-4 shrink-0 place-items-center rounded-full bg-[var(--wb-ink)] text-[var(--wb-on-ink)]" aria-hidden><Check size={10} strokeWidth={2.5} /></span>;
  if (state === "locked") return <Lock size={16} strokeWidth={1.5} className="shrink-0 text-[var(--wb-muted)]" aria-hidden />;
  return <span className="size-4 shrink-0 rounded-full shadow-[inset_0_0_0_1.5px_var(--wb-ring)]" aria-hidden />;
}

function connectCandidate(connections: readonly WorkbotConnection[] | undefined) {
  return connections?.find((connection) => !connection.ready && connection.connectMode !== "admin" && (connection.connectMode === "inline" || connection.connectUrl)) ?? null;
}

function StepAction({ step, flow }: { step: ActivationStep; flow: ReturnType<typeof useWorkbotConnect> }) {
  const destination = workbotHost().activation;
  if (step.done || step.lockedReason || step.id === "first_response" || !destination) return null;
  if (step.id === "connector") {
    const candidate = connectCandidate(flow.connections.data);
    if (candidate) return <WorkbotConnectionButton connection={candidate} flow={flow} label={`Connect ${candidate.name}`} />;
  }
  const label = step.id === "invite_teammate" ? "Invite" : step.id === "use_skill" ? "Try a skill" : step.id === "own_provider" ? "Add key" : step.id === "gateway_provider" ? "Share" : "Connect";
  return (
    <a className={actionClass} href={activationDenUrl(destination, step.id)} target="_blank" rel="noopener noreferrer" data-activation-action={step.id}>
      {label}<ExternalLink size={12} aria-label="Opens in a new tab" />
    </a>
  );
}

export function WorkbotSetupChip({ answered }: { answered: boolean }) {
  // Off (feature, or an older Workbot server): nothing renders and nothing is requested.
  return workbotHost().activation ? <SetupChip answered={answered} /> : null;
}

function SetupChip({ answered }: { answered: boolean }) {
  const host = workbotHost();
  const client = useQueryClient();
  const activation = useWorkbotActivation();
  const state = activation.data ?? null;

  const record = async (step: "first_response" | "dismiss") => {
    const { response, payload } = await host.requestJson("/v1/workbot/activation/events", { method: "POST", body: JSON.stringify({ step }) }, 15_000);
    const next = response.ok ? activationStateSchema.safeParse(payload) : null;
    if (next?.success) client.setQueryData(activationKey(), next.data);
  };

  // Workbot's first answer is something Den may not have heard about yet (the runner reports turns on its own schedule).
  const firstResponseDone = state ? orderedActivationSteps(state)[0]?.done === true : true;
  useEffect(() => {
    if (!answered || firstResponseDone || !host.identity) return;
    if (!claimActivationReport(`${host.identity.organizationId}:${host.identity.principalId}:first_response`)) return;
    void record("first_response").catch(() => undefined);
  }, [answered, firstResponseDone, host.identity?.organizationId, host.identity?.principalId]);

  const presentation = activationChecklistPresentation(state);
  if (presentation === "hidden" || !state) return null;
  return <SetupPopover state={state} presentation={presentation} onHide={() => void record("dismiss").catch(() => undefined)} />;
}

function SetupPopover({ state, presentation, onHide }: { state: ActivationState; presentation: "next" | "full"; onHide: () => void }) {
  const client = useQueryClient();
  const flow = useWorkbotConnect();
  const readyConnections = flow.connections.data?.filter((connection) => connection.ready).length ?? 0;
  const lastReady = useRef(readyConnections);
  // Connected is Den's word: when its readiness read changes, ask Den for the step again.
  useEffect(() => {
    if (readyConnections === lastReady.current) return;
    lastReady.current = readyConnections;
    void client.invalidateQueries({ queryKey: activationKey() });
  }, [readyConnections]);

  const progress = activationProgress(state);
  const next = nextActivationStep(state);
  const steps = orderedActivationSteps(state);
  return (
    <Popover.Root>
      <Popover.Trigger className={chipClass} data-testid="workbot-setup-chip" aria-label={presentation === "next" && next ? `Get set up, next: ${ACTIVATION_STEP_TITLES[next.id]}` : `Get set up, ${progress.done} of ${progress.total}`}>
        {presentation === "next" && next ? <span className="max-w-[220px] truncate">Next: {ACTIVATION_STEP_TITLES[next.id]}</span> : <>
          <span>Get set up</span>
          <span className="text-[var(--wb-muted)]">{progress.done} of {progress.total}</span>
        </>}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={12} className="z-50">
          <Popover.Popup data-testid="workbot-setup-panel" className="workbot flex max-h-[min(calc(100dvh-24px),var(--available-height,calc(100dvh-24px)))] w-[min(24rem,calc(100vw-24px))] flex-col overflow-y-auto rounded-xl bg-[var(--wb-surface)] p-1.5 text-[var(--wb-text)] shadow-[var(--wb-panel-shadow)] focus-visible:outline-none">
            <div className="flex items-center gap-2 px-2.5 pb-2 pt-1.5">
              <Popover.Title render={<h2 />} className="flex-1 text-[14px] font-semibold leading-5 tracking-[-0.01em]">Get set up</Popover.Title>
              <span className="text-[12px] text-[var(--wb-muted)]">{progress.done} of {progress.total}</span>
              {!state.dismissed && (
                <button type="button" aria-label="Hide checklist" className="grid size-7 place-items-center rounded-lg text-[var(--wb-muted)] hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]" onClick={onHide}>
                  <X size={16} strokeWidth={1.5} aria-hidden />
                </button>
              )}
            </div>
            <div className="mx-2.5 mb-1.5 h-1 overflow-hidden rounded-full bg-[var(--wb-chip)]" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} aria-label="Setup progress">
              <div className="h-full rounded-full bg-[var(--wb-ink)] transition-[width] duration-200 ease-out" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
            </div>
            <ol className="flex flex-col">
              {steps.map((step) => {
                const status = rowState(step);
                const line = step.done ? step.detail : step.lockedReason;
                return (
                  <li key={step.id} data-testid={`workbot-setup-step-${step.id}`} data-state={status} className="flex min-h-11 items-center gap-2.5 border-t border-[var(--wb-hairline)] px-2.5 py-2 first:border-t-0">
                    <StepMark state={status} />
                    <div className="min-w-0 flex-1">
                      <p className={`truncate text-[13px] leading-[18px] ${step.done ? "text-[var(--wb-muted)]" : "font-medium"}`}>{ACTIVATION_STEP_TITLES[step.id]}</p>
                      {line && <p className="truncate text-[12px] leading-4 text-[var(--wb-muted)]">{line}</p>}
                    </div>
                    <StepAction step={step} flow={flow} />
                  </li>
                );
              })}
            </ol>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
