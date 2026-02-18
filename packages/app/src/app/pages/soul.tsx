import { For, Show, createMemo, createSignal } from "solid-js";
import { Activity, HeartPulse, RefreshCw, Sparkles } from "lucide-solid";

import type { OpenworkSoulHeartbeatEntry, OpenworkSoulStatus } from "../lib/openwork-server";
import { formatRelativeTime } from "../utils";

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

const cadenceOptions = [
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Every 12 hours", cron: "0 */12 * * *" },
  { label: "Every day", cron: "0 9 * * *" },
];

const relativeTime = (value?: string | null) => {
  if (!value) return "Never";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return formatRelativeTime(parsed);
};

export default function SoulView(props: SoulViewProps) {
  const [focusInput, setFocusInput] = createSignal("");
  const [boundariesInput, setBoundariesInput] = createSignal("");
  const [cadence, setCadence] = createSignal(cadenceOptions[1]?.cron ?? "0 */12 * * *");

  const statusMeta = createMemo(() => {
    const state = props.status?.state ?? "off";
    switch (state) {
      case "healthy":
        return {
          label: "Soul on",
          tone: "border-emerald-7/50 bg-emerald-3/30 text-emerald-11",
          dot: "bg-emerald-9",
        };
      case "stale":
        return {
          label: "Heartbeat stale",
          tone: "border-amber-7/50 bg-amber-3/30 text-amber-11",
          dot: "bg-amber-9",
        };
      case "error":
        return {
          label: "Heartbeat error",
          tone: "border-red-7/50 bg-red-3/30 text-red-11",
          dot: "bg-red-9",
        };
      default:
        return {
          label: "Soul off",
          tone: "border-gray-6 bg-gray-2 text-gray-10",
          dot: "bg-gray-7",
        };
    }
  });

  const runPrompt = (prompt: string) => {
    if (props.newTaskDisabled) return;
    props.runSoulPrompt(prompt);
  };

  const cadenceLabel = createMemo(() => {
    return cadenceOptions.find((option) => option.cron === cadence())?.label ?? cadence();
  });

  return (
    <section class="space-y-8">
      <div class="rounded-2xl border border-dls-border bg-dls-surface p-6 md:p-7">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="space-y-2">
            <div class="flex items-center gap-2">
              <HeartPulse size={18} class="text-dls-secondary" />
              <h2 class="text-xl font-semibold text-dls-text">Soul and Heartbeat</h2>
              <span class={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusMeta().tone}`}>
                {statusMeta().label}
              </span>
            </div>
            <p class="text-sm text-dls-secondary max-w-2xl">
              Track whether this worker has a soul, monitor heartbeat check-ins, and steer what Soul should focus on next.
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
            {props.loading ? "Refreshing" : "Refresh"}
          </button>
        </div>

        <Show when={props.error}>
          <div class="mt-4 rounded-xl border border-red-7/40 bg-red-3/40 px-4 py-3 text-sm text-red-11">
            {props.error}
          </div>
        </Show>

        <div class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div class="rounded-xl border border-dls-border bg-dls-hover/40 px-4 py-3">
            <div class="text-[11px] uppercase tracking-wide text-dls-secondary">Worker</div>
            <div class="mt-1 text-sm text-dls-text truncate">{props.workspaceName}</div>
          </div>
          <div class="rounded-xl border border-dls-border bg-dls-hover/40 px-4 py-3">
            <div class="text-[11px] uppercase tracking-wide text-dls-secondary">Last heartbeat</div>
            <div class="mt-1 text-sm text-dls-text">{relativeTime(props.status?.lastHeartbeatAt)}</div>
          </div>
          <div class="rounded-xl border border-dls-border bg-dls-hover/40 px-4 py-3">
            <div class="text-[11px] uppercase tracking-wide text-dls-secondary">Heartbeat count</div>
            <div class="mt-1 text-sm text-dls-text">{props.status?.heartbeatCount ?? 0}</div>
          </div>
          <div class="rounded-xl border border-dls-border bg-dls-hover/40 px-4 py-3">
            <div class="text-[11px] uppercase tracking-wide text-dls-secondary">Schedule</div>
            <div class="mt-1 text-sm text-dls-text truncate">
              {props.status?.heartbeatJob?.schedule || "No heartbeat schedule"}
            </div>
          </div>
        </div>

        <div class="mt-4 rounded-xl border border-dls-border bg-dls-hover/30 px-4 py-3 text-sm text-dls-secondary">
          {props.status?.summary || "Soul status has not been loaded yet."}
        </div>

        <Show when={!props.status?.enabled}>
          <button
            type="button"
            class={`mt-4 inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              props.newTaskDisabled
                ? "bg-gray-3 text-gray-8"
                : "bg-dls-text text-dls-surface hover:bg-dls-text/90"
            }`}
            disabled={props.newTaskDisabled}
            onClick={() => runPrompt("Give me a soul.")}
          >
            <Sparkles size={14} />
            Enable soul mode
          </button>
        </Show>
      </div>

      <div class="grid gap-6 lg:grid-cols-2">
        <div class="rounded-2xl border border-dls-border bg-dls-surface p-6 space-y-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h3 class="text-base font-semibold text-dls-text">Follow up on heartbeats</h3>
              <p class="text-xs text-dls-secondary">Recent check-ins, loose ends, and next actions.</p>
            </div>
            <Show when={props.loadingHeartbeats}>
              <span class="text-xs text-dls-secondary">Loading...</span>
            </Show>
          </div>

          <Show
            when={props.heartbeats.length > 0}
            fallback={
              <div class="rounded-xl border border-dls-border bg-dls-hover/40 px-4 py-6 text-sm text-dls-secondary">
                No heartbeat entries yet. Run `/soul-heartbeat` to create the first check-in.
              </div>
            }
          >
            <div class="space-y-3 max-h-[22rem] overflow-y-auto pr-1">
              <For each={props.heartbeats}>
                {(entry) => (
                  <div class="rounded-xl border border-dls-border bg-dls-hover/30 px-4 py-3 space-y-2">
                    <div class="flex items-center justify-between gap-3">
                      <div class="flex items-center gap-2 min-w-0">
                        <span class={`h-2 w-2 rounded-full ${statusMeta().dot}`} />
                        <span class="text-xs text-dls-secondary truncate">{relativeTime(entry.ts)}</span>
                      </div>
                    </div>
                    <div class="text-sm text-dls-text">{entry.summary}</div>
                    <Show when={entry.looseEnds.length > 0}>
                      <div class="space-y-1">
                        <div class="text-[11px] uppercase tracking-wide text-dls-secondary">Loose ends</div>
                        <ul class="space-y-1 text-xs text-dls-secondary">
                          <For each={entry.looseEnds.slice(0, 3)}>
                            {(item) => <li>- {item}</li>}
                          </For>
                        </ul>
                      </div>
                    </Show>
                    <Show when={entry.nextAction}>
                      <div class="text-xs text-dls-text">
                        <span class="text-dls-secondary">Next:</span> {entry.nextAction}
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>

        <div class="rounded-2xl border border-dls-border bg-dls-surface p-6 space-y-4">
          <div>
            <h3 class="text-base font-semibold text-dls-text">Steer soul</h3>
            <p class="text-xs text-dls-secondary">
              Adjust focus, boundaries, and cadence. Actions open a task with the right steering prompt.
            </p>
          </div>

          <div class="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              class="rounded-xl border border-dls-border px-3 py-2 text-left text-sm text-dls-text hover:bg-dls-hover disabled:opacity-60"
              disabled={props.newTaskDisabled}
              onClick={() =>
                runPrompt(
                  "Run /soul-heartbeat now. Then summarize the latest status with loose ends and one concrete next action.",
                )
              }
            >
              Run heartbeat now
            </button>
            <button
              type="button"
              class="rounded-xl border border-dls-border px-3 py-2 text-left text-sm text-dls-text hover:bg-dls-hover disabled:opacity-60"
              disabled={props.newTaskDisabled}
              onClick={() =>
                runPrompt(
                  `Review ${props.workspaceRoot || "this worker"} and recent heartbeats. Prioritize the top 3 loose ends and propose a clear plan.`,
                )
              }
            >
              Prioritize loose ends
            </button>
          </div>

          <div class="space-y-2">
            <label class="text-xs font-medium text-dls-secondary">Current focus</label>
            <input
              type="text"
              value={focusInput()}
              onInput={(event) => setFocusInput(event.currentTarget.value)}
              placeholder="Ship soul UI for remote workers"
              class="w-full rounded-xl border border-dls-border bg-dls-hover/40 px-3 py-2 text-sm text-dls-text placeholder:text-dls-secondary focus:outline-none"
            />
            <button
              type="button"
              class="rounded-lg border border-dls-border px-3 py-1.5 text-xs text-dls-text hover:bg-dls-hover disabled:opacity-60"
              disabled={props.newTaskDisabled || !focusInput().trim()}
              onClick={() =>
                runPrompt(
                  `Update .opencode/soul.md so Current focus is: ${focusInput().trim()}. Keep the rest intact and explain what changed.`,
                )
              }
            >
              Update focus
            </button>
          </div>

          <div class="space-y-2">
            <label class="text-xs font-medium text-dls-secondary">Boundaries and guardrails</label>
            <input
              type="text"
              value={boundariesInput()}
              onInput={(event) => setBoundariesInput(event.currentTarget.value)}
              placeholder="Keep heartbeat concise and non-destructive"
              class="w-full rounded-xl border border-dls-border bg-dls-hover/40 px-3 py-2 text-sm text-dls-text placeholder:text-dls-secondary focus:outline-none"
            />
            <button
              type="button"
              class="rounded-lg border border-dls-border px-3 py-1.5 text-xs text-dls-text hover:bg-dls-hover disabled:opacity-60"
              disabled={props.newTaskDisabled || !boundariesInput().trim()}
              onClick={() =>
                runPrompt(
                  `Update .opencode/soul.md Preferences with this boundary: ${boundariesInput().trim()}. Keep existing preferences and append this one clearly.`,
                )
              }
            >
              Update boundaries
            </button>
          </div>

          <div class="space-y-2 rounded-xl border border-dls-border bg-dls-hover/30 p-3">
            <div class="flex items-center gap-2 text-sm text-dls-text">
              <Activity size={14} class="text-dls-secondary" />
              Heartbeat cadence
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <select
                class="rounded-lg border border-dls-border bg-dls-surface px-2 py-1.5 text-xs text-dls-text"
                value={cadence()}
                onChange={(event) => setCadence(event.currentTarget.value)}
              >
                <For each={cadenceOptions}>
                  {(option) => <option value={option.cron}>{option.label}</option>}
                </For>
              </select>
              <button
                type="button"
                class="rounded-lg border border-dls-border px-3 py-1.5 text-xs text-dls-text hover:bg-dls-hover disabled:opacity-60"
                disabled={props.newTaskDisabled}
                onClick={() =>
                  runPrompt(
                    `Update the soul-heartbeat scheduler job to ${cadenceLabel()} using cron ${cadence()}. Then confirm next expected heartbeat time.`,
                  )
                }
              >
                Apply cadence
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
