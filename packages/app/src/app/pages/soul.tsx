import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Activity, CheckCircle2, Circle, HeartPulse, RefreshCw, Sparkles } from "lucide-solid";

import type { OpenworkSoulHeartbeatEntry, OpenworkSoulStatus } from "../lib/openwork-server";
import { currentLocale, t } from "../../i18n";
import soulSetupTemplate from "../data/commands/give-me-a-soul.md?raw";
import { formatRelativeTime, parseTemplateFrontmatter } from "../utils";

type SoulViewProps = {
  workspaceName: string;
  workspaceRoot: string;
  status: OpenworkSoulStatus | null;
  heartbeats: OpenworkSoulHeartbeatEntry[];
  loading: boolean;
  loadingHeartbeats: boolean;
  error: string | null;
  newTaskDisabled: boolean;
  refresh: (options?: { force?: boolean }) => void;
  runSoulPrompt: (prompt: string) => void;
};

const getCadenceOptions = () => [
  { labelKey: "soul.cadence_every_6_hours", cron: "0 */6 * * *" },
  { labelKey: "soul.cadence_every_12_hours", cron: "0 */12 * * *" },
  { labelKey: "soul.cadence_every_day", cron: "0 9 * * *" },
];

const SOUL_SETUP_TEMPLATE = (() => {
  const parsed = parseTemplateFrontmatter(soulSetupTemplate);
  const name = parsed?.data?.name?.trim() || "give-me-a-soul";
  const body = (parsed?.body ?? soulSetupTemplate).trim();
  return { name, body };
})();

const relativeTime = (value?: string | null, trFunc?: (key: string) => string) => {
  if (!value) return trFunc?.("soul.never") ?? "Never";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return formatRelativeTime(parsed);
};

// Translation helper - ใช้แทน t() เพื่อความกระชับ
const tr = (key: string, params?: Record<string, string | number>) => t(key, currentLocale(), params);

export default function SoulView(props: SoulViewProps) {
  const [focusInput, setFocusInput] = createSignal("");
  const [boundariesInput, setBoundariesInput] = createSignal("");
  const [cadence, setCadence] = createSignal(getCadenceOptions()[1]?.cron ?? "0 */12 * * *");
  const [heartbeatRunState, setHeartbeatRunState] = createSignal<"idle" | "running" | "success" | "warning">("idle");
  const [heartbeatRunMessage, setHeartbeatRunMessage] = createSignal<string | null>(null);
  const [heartbeatBaselineTs, setHeartbeatBaselineTs] = createSignal<string | null>(null);
  const [heartbeatRunStartedAt, setHeartbeatRunStartedAt] = createSignal<number | null>(null);
  let heartbeatPollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  const statusMeta = createMemo(() => {
    const state = props.status?.state ?? "off";
    switch (state) {
      case "healthy":
        return {
          label: tr("soul.status_soul_on"),
          tone: "border-emerald-7/50 bg-emerald-3/30 text-emerald-11",
          dot: "bg-emerald-9",
        };
      case "stale":
        return {
          label: tr("soul.status_heartbeat_stale"),
          tone: "border-amber-7/50 bg-amber-3/30 text-amber-11",
          dot: "bg-amber-9",
        };
      case "error":
        return {
          label: tr("soul.status_heartbeat_error"),
          tone: "border-red-7/50 bg-red-3/30 text-red-11",
          dot: "bg-red-9",
        };
      default:
        return {
          label: tr("soul.status_soul_off"),
          tone: "border-gray-6 bg-gray-2 text-gray-10",
          dot: "bg-gray-7",
        };
    }
  });

  const runPrompt = (prompt: string) => {
    if (props.newTaskDisabled) return;
    props.runSoulPrompt(prompt);
  };

  const enableSoulPrompt = createMemo(() => {
    const body = SOUL_SETUP_TEMPLATE.body.trim();
    if (body) return body;
    return `/${SOUL_SETUP_TEMPLATE.name}`;
  });

  const latestHeartbeat = createMemo(() => props.heartbeats[0] ?? null);

  const setupAuditItems = createMemo(() => {
    const status = props.status;
    if (!status) {
      return [
        { id: "memory", label: tr("soul.audit_memory_label"), passed: false, detail: tr("soul.audit_memory_waiting") },
        { id: "instructions", label: tr("soul.audit_instructions_label"), passed: false, detail: tr("soul.audit_memory_waiting") },
        { id: "command", label: tr("soul.audit_command_label"), passed: false, detail: tr("soul.audit_memory_waiting") },
        { id: "job", label: tr("soul.audit_job_label"), passed: false, detail: tr("soul.audit_memory_waiting") },
        { id: "log", label: tr("soul.audit_log_label"), passed: false, detail: tr("soul.audit_memory_waiting") },
        { id: "proof", label: tr("soul.audit_proof_label"), passed: false, detail: tr("soul.audit_proof_detail_missing") },
      ];
    }

    return [
      {
        id: "memory",
        label: tr("soul.audit_memory_label"),
        passed: status.memoryEnabled,
        detail: status.memoryEnabled ? status.memoryPath : tr("soul.audit_memory_missing"),
      },
      {
        id: "instructions",
        label: tr("soul.audit_instructions_label"),
        passed: status.instructionsEnabled,
        detail: status.instructionsEnabled
          ? tr("soul.audit_instructions_detail_ok")
          : tr("soul.audit_instructions_detail_missing"),
      },
      {
        id: "command",
        label: tr("soul.audit_command_label"),
        passed: status.heartbeatCommandExists,
        detail: status.heartbeatCommandExists ? tr("soul.audit_command_detail_ok") : tr("soul.audit_command_detail_missing"),
      },
      {
        id: "job",
        label: tr("soul.audit_job_label"),
        passed: Boolean(status.heartbeatJob),
        detail: status.heartbeatJob?.schedule || tr("soul.audit_job_detail_missing"),
      },
      {
        id: "log",
        label: tr("soul.audit_log_label"),
        passed: status.heartbeatLogExists,
        detail: status.heartbeatLogExists ? status.heartbeatPath : tr("soul.audit_log_detail_missing"),
      },
      {
        id: "proof",
        label: tr("soul.audit_proof_label"),
        passed: Boolean(status.lastHeartbeatAt),
        detail: status.lastHeartbeatAt ? tr("soul.audit_proof_detail_ok", { time: relativeTime(status.lastHeartbeatAt, tr) }) : tr("soul.audit_proof_detail_missing"),
      },
    ];
  });

  const steeringAudit = createMemo(() => {
    const latest = latestHeartbeat();
    const looseEndCount = latest?.looseEnds.length ?? 0;
    return [
      {
        id: "heartbeat",
        label: tr("soul.steering_heartbeat_label"),
        passed: props.heartbeats.length > 0,
        detail: latest?.ts ? `Latest ${relativeTime(latest.ts, tr)}` : tr("soul.steering_heartbeat_detail_missing"),
      },
      {
        id: "loose-ends",
        label: tr("soul.steering_loose_ends_label"),
        passed: looseEndCount > 0,
        detail: looseEndCount > 0 ? tr("soul.steering_loose_ends_detail_ok", { count: looseEndCount, s: looseEndCount === 1 ? "" : "s" }) : tr("soul.steering_loose_ends_detail_missing"),
      },
      {
        id: "next-action",
        label: tr("soul.steering_next_action_label"),
        passed: Boolean(latest?.nextAction),
        detail: latest?.nextAction || tr("soul.steering_next_action_detail_missing"),
      },
    ];
  });

  const clearHeartbeatTimers = () => {
    if (heartbeatPollTimer) {
      clearInterval(heartbeatPollTimer);
      heartbeatPollTimer = null;
    }
    if (heartbeatTimeoutTimer) {
      clearTimeout(heartbeatTimeoutTimer);
      heartbeatTimeoutTimer = null;
    }
  };

  const runHeartbeatNow = () => {
    if (props.newTaskDisabled || heartbeatRunState() === "running") return;
    const baselineTs = props.heartbeats[0]?.ts ?? props.status?.lastHeartbeatAt ?? null;
    setHeartbeatBaselineTs(baselineTs);
    setHeartbeatRunStartedAt(Date.now());
    setHeartbeatRunState("running");
    setHeartbeatRunMessage(tr("soul.heartbeat_started_hint"));
    clearHeartbeatTimers();

    runPrompt(tr("soul.prompt_run_heartbeat"));

    void props.refresh({ force: true });

    heartbeatPollTimer = setInterval(() => {
      void props.refresh({ force: true });
    }, 3000);

    heartbeatTimeoutTimer = setTimeout(() => {
      if (heartbeatRunState() !== "running") return;
      clearHeartbeatTimers();
      setHeartbeatRunState("warning");
      setHeartbeatRunMessage(tr("soul.heartbeat_timeout_hint"));
    }, 45000);
  };

  const heartbeatStatusCardTone = createMemo(() => {
    const state = heartbeatRunState();
    if (state === "success") return "border-emerald-7/50 bg-emerald-3/30 text-emerald-11";
    if (state === "warning") return "border-amber-7/50 bg-amber-3/30 text-amber-11";
    if (state === "running") return "border-blue-7/50 bg-blue-3/30 text-blue-11";
    return "border-dls-border bg-dls-hover/30 text-dls-secondary";
  });

  const heartbeatStatusTitle = createMemo(() => {
    const state = heartbeatRunState();
    if (state === "success") return tr("soul.heartbeat_completed");
    if (state === "warning") return tr("soul.heartbeat_still_running");
    if (state === "running") return tr("soul.heartbeat_in_progress");
    return tr("soul.run_heartbeat");
  });

  createEffect(() => {
    if (heartbeatRunState() !== "running") return;
    const latestTs = props.heartbeats[0]?.ts ?? props.status?.lastHeartbeatAt ?? null;
    if (!latestTs) return;
    const baselineTs = heartbeatBaselineTs();
    const startedAt = heartbeatRunStartedAt();
    const parsedLatest = Date.parse(latestTs);
    if (baselineTs && latestTs === baselineTs) return;
    if (Number.isFinite(parsedLatest) && startedAt && parsedLatest < startedAt - 1000) return;

    clearHeartbeatTimers();
    setHeartbeatRunState("success");
    setHeartbeatRunMessage(tr("soul.latest_checkin", { time: relativeTime(latestTs, tr) }));
  });

  onCleanup(() => {
    clearHeartbeatTimers();
  });

  const cadenceLabel = createMemo(() => {
    return tr(getCadenceOptions().find((option) => option.cron === cadence())?.labelKey ?? "") ?? cadence();
  });

  return (
    <section class="space-y-8">
      <div class="rounded-2xl border border-dls-border bg-dls-surface p-6 md:p-7">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="space-y-2">
            <div class="flex items-center gap-2">
              <HeartPulse size={18} class="text-dls-secondary" />
              <h2 class="text-xl font-semibold text-dls-text">{tr("soul.title")}</h2>
              <span class={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusMeta().tone}`}>
                {statusMeta().label}
              </span>
            </div>
            <p class="text-sm text-dls-secondary max-w-2xl">
              {tr("soul.description")}
            </p>
          </div>
          <button
            type="button"
            class={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              props.loading
                ? "border-gray-6 text-gray-8"
                : "border-dls-border text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
            }`}
            disabled={props.loading}
            onClick={() => props.refresh({ force: true })}
          >
            <RefreshCw size={14} class={props.loading ? "animate-spin" : ""} />
            {props.loading ? tr("soul.refreshing") : tr("soul.refresh")}
          </button>
        </div>

        <Show when={props.error}>
          <div class="mt-4 rounded-xl border border-red-7/40 bg-red-3/40 px-4 py-3 text-sm text-red-11">
            {props.error}
          </div>
        </Show>

        <div class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div class="rounded-xl border border-dls-border bg-dls-hover/40 px-4 py-3">
            <div class="text-[11px] uppercase tracking-wide text-dls-secondary">{tr("soul.worker_label")}</div>
            <div class="mt-1 text-sm text-dls-text truncate">{props.workspaceName}</div>
          </div>
          <div class="rounded-xl border border-dls-border bg-dls-hover/40 px-4 py-3">
            <div class="text-[11px] uppercase tracking-wide text-dls-secondary">{tr("soul.last_heartbeat_label")}</div>
            <div class="mt-1 text-sm text-dls-text">{relativeTime(props.status?.lastHeartbeatAt, tr)}</div>
          </div>
          <div class="rounded-xl border border-dls-border bg-dls-hover/40 px-4 py-3">
            <div class="text-[11px] uppercase tracking-wide text-dls-secondary">{tr("soul.heartbeat_count_label")}</div>
            <div class="mt-1 text-sm text-dls-text">{props.status?.heartbeatCount ?? 0}</div>
          </div>
          <div class="rounded-xl border border-dls-border bg-dls-hover/40 px-4 py-3">
            <div class="text-[11px] uppercase tracking-wide text-dls-secondary">{tr("soul.schedule_label")}</div>
            <div class="mt-1 text-sm text-dls-text truncate">
              {props.status?.heartbeatJob?.schedule || tr("soul.no_schedule")}
            </div>
          </div>
        </div>

        <div class="mt-4 rounded-xl border border-dls-border bg-dls-hover/30 px-4 py-3 text-sm text-dls-secondary">
          {props.status?.summary || tr("soul.status_not_loaded")}
        </div>

        <Show when={!props.status?.enabled}>
          <div class="mt-4 rounded-xl border border-blue-7/40 bg-blue-3/20 p-3 flex flex-wrap items-center justify-between gap-3">
            <div class="text-xs text-blue-11 max-w-lg">
              {tr("soul.not_enabled")}
            </div>
            <button
              type="button"
              class={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                props.newTaskDisabled
                  ? "bg-gray-3 text-gray-8"
                  : "bg-dls-text text-dls-surface hover:bg-dls-text/90"
              }`}
              disabled={props.newTaskDisabled}
              onClick={() => runPrompt(enableSoulPrompt())}
            >
              <Sparkles size={14} />
              {tr("soul.enable_action")}
            </button>
          </div>
        </Show>

        <div class="mt-6 rounded-xl border border-dls-border bg-dls-hover/20 p-4 space-y-3">
          <div class="flex items-center justify-between gap-3">
            <h3 class="text-sm font-semibold text-dls-text">{tr("soul.audit_title")}</h3>
            <div class="text-[11px] text-dls-secondary">
              {tr("soul.audit_passing", { passed: setupAuditItems().filter((item) => item.passed).length, total: setupAuditItems().length })}
            </div>
          </div>
          <div class="grid gap-2 md:grid-cols-2">
            <For each={setupAuditItems()}>
              {(item) => (
                <div
                  class={`rounded-lg border px-3 py-2 ${
                    item.passed
                      ? "border-emerald-7/40 bg-emerald-3/20"
                      : "border-dls-border bg-dls-hover/30"
                  }`}
                >
                  <div class="flex items-start gap-2">
                    <Show
                      when={item.passed}
                      fallback={<Circle size={14} class="mt-0.5 text-dls-secondary shrink-0" />}
                    >
                      <CheckCircle2 size={14} class="mt-0.5 text-emerald-11 shrink-0" />
                    </Show>
                    <div class="min-w-0">
                      <div class="text-xs font-medium text-dls-text">{item.label}</div>
                      <div class="text-[11px] text-dls-secondary truncate">{item.detail}</div>
                    </div>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>

      <div class="grid gap-6 lg:grid-cols-2">
        <div class="rounded-2xl border border-dls-border bg-dls-surface p-6 space-y-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h3 class="text-base font-semibold text-dls-text">{tr("soul.proof_title")}</h3>
              <p class="text-xs text-dls-secondary">{tr("soul.proof_description")}</p>
            </div>
            <Show when={props.loadingHeartbeats}>
              <span class="text-xs text-dls-secondary">{tr("soul.loading")}</span>
            </Show>
          </div>

          <Show
            when={latestHeartbeat()}
            fallback={
              <div class="rounded-xl border border-dls-border bg-dls-hover/40 px-4 py-6 text-sm text-dls-secondary">
                {tr("soul.no_proof")}
              </div>
            }
          >
            {(entry) => (
              <div class="rounded-xl border border-dls-border bg-dls-hover/30 px-4 py-3 space-y-2">
                <div class="flex items-center gap-2 text-xs text-dls-secondary">
                  <span class={`h-2 w-2 rounded-full ${statusMeta().dot}`} />
                  {tr("soul.latest_checkin_label")} {relativeTime(entry().ts, tr)}
                </div>
                <div class="text-sm text-dls-text">{entry().summary}</div>
                <Show when={entry().nextAction}>
                  <div class="text-xs text-dls-text">
                    <span class="text-dls-secondary">{tr("soul.next_action_prefix")}</span> {entry().nextAction}
                  </div>
                </Show>
                <Show when={entry().looseEnds.length > 0}>
                  <div class="space-y-1">
                    <div class="text-[11px] uppercase tracking-wide text-dls-secondary">{tr("soul.loose_ends")}</div>
                    <ul class="space-y-1 text-xs text-dls-secondary">
                      <For each={entry().looseEnds.slice(0, 3)}>
                        {(item) => <li>- {item}</li>}
                      </For>
                    </ul>
                  </div>
                </Show>
              </div>
            )}
          </Show>

          <Show when={props.heartbeats.length > 1}>
            <div class="space-y-3 max-h-[18rem] overflow-y-auto pr-1">
              <For each={props.heartbeats.slice(1)}>
                {(entry) => (
                  <div class="rounded-xl border border-dls-border bg-dls-hover/20 px-4 py-3 space-y-1.5">
                    <div class="text-xs text-dls-secondary">{relativeTime(entry.ts)}</div>
                    <div class="text-sm text-dls-text">{entry.summary}</div>
                    <Show when={entry.nextAction}>
                      <div class="text-xs text-dls-secondary truncate">{tr("soul.next_action_prefix")} {entry.nextAction}</div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>

        <div class="space-y-6">
          <div class="rounded-2xl border border-dls-border bg-dls-surface p-6 space-y-4">
            <div>
              <h3 class="text-base font-semibold text-dls-text">{tr("soul.steering_title")}</h3>
              <p class="text-xs text-dls-secondary">
                {tr("soul.steering_description")}
              </p>
            </div>

            <div class="space-y-2">
              <For each={steeringAudit()}>
                {(item) => (
                  <div class="rounded-lg border border-dls-border bg-dls-hover/20 px-3 py-2 flex items-start gap-2">
                    <Show
                      when={item.passed}
                      fallback={<Circle size={14} class="mt-0.5 text-dls-secondary shrink-0" />}
                    >
                      <CheckCircle2 size={14} class="mt-0.5 text-emerald-11 shrink-0" />
                    </Show>
                    <div class="min-w-0">
                      <div class="text-xs font-medium text-dls-text">{item.label}</div>
                      <div class="text-[11px] text-dls-secondary truncate">{item.detail}</div>
                    </div>
                  </div>
                )}
              </For>
            </div>

            <div class="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                class="rounded-xl border border-dls-border px-3 py-2 text-left text-sm text-dls-text hover:bg-dls-hover disabled:opacity-60"
                disabled={props.newTaskDisabled || heartbeatRunState() === "running"}
                onClick={runHeartbeatNow}
              >
                {heartbeatRunState() === "running" ? tr("soul.running_heartbeat") : tr("soul.run_heartbeat")}
              </button>
              <button
                type="button"
                class="rounded-xl border border-dls-border px-3 py-2 text-left text-sm text-dls-text hover:bg-dls-hover disabled:opacity-60"
                disabled={props.newTaskDisabled}
                onClick={() =>
                  runPrompt(
                    tr("soul.prompt_prioritize_loose_ends", { worker: props.workspaceRoot || tr("soul.this_worker") }),
                  )
                }
              >
                {tr("soul.prioritize_loose_ends")}
              </button>
              <button
                type="button"
                class="rounded-xl border border-dls-border px-3 py-2 text-left text-sm text-dls-text hover:bg-dls-hover disabled:opacity-60 sm:col-span-2"
                disabled={props.newTaskDisabled}
                onClick={() =>
                  runPrompt(tr("soul.prompt_improvement_sweep"))
                }
              >
                {tr("soul.improvement_sweep")}
              </button>
            </div>

            <div class={`rounded-xl border px-3 py-2 text-xs ${heartbeatStatusCardTone()}`}>
              <div class="font-medium">{heartbeatStatusTitle()}</div>
              <div class="mt-1">{heartbeatRunMessage() || tr("soul.heartbeat_live_status")}</div>
            </div>
          </div>

          <div class="rounded-2xl border border-dls-border bg-dls-surface p-6 space-y-4">
            <div class="space-y-2">
              <label class="text-xs font-medium text-dls-secondary">{tr("soul.current_focus_label")}</label>
              <input
                type="text"
                value={focusInput()}
                onInput={(event) => setFocusInput(event.currentTarget.value)}
                placeholder={tr("soul.focus_placeholder")}
                class="w-full rounded-xl border border-dls-border bg-dls-hover/40 px-3 py-2 text-sm text-dls-text placeholder:text-dls-secondary focus:outline-none"
              />
              <button
                type="button"
                class="rounded-lg border border-dls-border px-3 py-1.5 text-xs text-dls-text hover:bg-dls-hover disabled:opacity-60"
                disabled={props.newTaskDisabled || !focusInput().trim()}
                onClick={() =>
                  runPrompt(
                    tr("soul.prompt_update_focus", { focus: focusInput().trim() }),
                  )
                }
              >
                {tr("soul.update_focus")}
              </button>
            </div>

            <div class="space-y-2">
              <label class="text-xs font-medium text-dls-secondary">{tr("soul.boundaries_label")}</label>
              <input
                type="text"
                value={boundariesInput()}
                onInput={(event) => setBoundariesInput(event.currentTarget.value)}
                placeholder={tr("soul.boundaries_placeholder")}
                class="w-full rounded-xl border border-dls-border bg-dls-hover/40 px-3 py-2 text-sm text-dls-text placeholder:text-dls-secondary focus:outline-none"
              />
              <button
                type="button"
                class="rounded-lg border border-dls-border px-3 py-1.5 text-xs text-dls-text hover:bg-dls-hover disabled:opacity-60"
                disabled={props.newTaskDisabled || !boundariesInput().trim()}
                onClick={() =>
                  runPrompt(
                    tr("soul.prompt_update_boundaries", { boundary: boundariesInput().trim() }),
                  )
                }
              >
                {tr("soul.update_boundaries")}
              </button>
            </div>

            <div class="space-y-2 rounded-xl border border-dls-border bg-dls-hover/30 p-3">
              <div class="flex items-center gap-2 text-sm text-dls-text">
                <Activity size={14} class="text-dls-secondary" />
                {tr("soul.cadence_label")}
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <select
                  class="rounded-lg border border-dls-border bg-dls-surface px-2 py-1.5 text-xs text-dls-text"
                  value={cadence()}
                  onChange={(event) => setCadence(event.currentTarget.value)}
                >
                  <For each={getCadenceOptions()}>
                    {(option) => <option value={option.cron}>{tr(option.labelKey)}</option>}
                  </For>
                </select>
                <button
                  type="button"
                  class="rounded-lg border border-dls-border px-3 py-1.5 text-xs text-dls-text hover:bg-dls-hover disabled:opacity-60"
                  disabled={props.newTaskDisabled}
                  onClick={() =>
                    runPrompt(
                      tr("soul.prompt_apply_cadence", { label: cadenceLabel(), cron: cadence() }),
                    )
                  }
                >
                  {tr("soul.apply_cadence")}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
