/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Clock3, Settings2 } from "lucide-react";
import type {
  ScheduledTaskDefinition,
  ScheduledTaskSchedule,
  ScheduledTaskSchedulePreview,
} from "@openwork/types/scheduled-tasks";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";

const WEEKDAYS = [
  { value: 1, day: 5 },
  { value: 2, day: 6 },
  { value: 3, day: 7 },
  { value: 4, day: 8 },
  { value: 5, day: 9 },
  { value: 6, day: 10 },
  { value: 0, day: 11 },
] as const;

function weekdayLabel(day: number) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(2024, 0, day));
}

function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function initialDefinition(workspaceId: string): ScheduledTaskDefinition {
  return {
    name: "",
    description: "",
    prompt: "",
    workspaceId,
    schedule: {
      kind: "manual",
      timezone: localTimezone(),
    },
    model: {
      providerId: null,
      modelId: null,
      agent: null,
    },
    maximumRuntimeMs: 30 * 60 * 1_000,
    overlapPolicy: "skip",
    retryPolicy: {
      maximumAttempts: 1,
      delayMs: 0,
    },
    missedRunPolicy: {
      kind: "skip",
      graceMs: 60_000,
      maximumRecoverableOccurrences: 1,
    },
  };
}

function scheduledTime(schedule: ScheduledTaskSchedule) {
  if (schedule.kind === "manual") return { hour: 9, minute: 0 };
  return { hour: schedule.hour, minute: schedule.minute };
}

export type ScheduledTaskEditorProps = {
  workspaceId: string;
  initial?: ScheduledTaskDefinition | null;
  busy: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSave: (definition: ScheduledTaskDefinition) => Promise<void> | void;
  onPreview: (schedule: ScheduledTaskSchedule) => Promise<ScheduledTaskSchedulePreview>;
};

export function ScheduledTaskEditor(props: ScheduledTaskEditorProps) {
  const [definition, setDefinition] = useState<ScheduledTaskDefinition>(
    () => props.initial ?? initialDefinition(props.workspaceId),
  );
  const [preview, setPreview] = useState<ScheduledTaskSchedulePreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    setDefinition(props.initial ?? initialDefinition(props.workspaceId));
    setPreview(null);
    setPreviewError("");
    setAdvancedOpen(false);
  }, [props.initial, props.workspaceId]);

  const canSave = useMemo(
    () => definition.name.trim().length > 0 && definition.prompt.trim().length > 0,
    [definition.name, definition.prompt],
  );
  const time = scheduledTime(definition.schedule);

  const changeScheduleKind = (kind: ScheduledTaskSchedule["kind"]) => {
    const timezone = definition.schedule.timezone;
    if (kind === "manual") {
      setDefinition((current) => ({ ...current, schedule: { kind, timezone } }));
      return;
    }
    if (kind === "daily") {
      setDefinition((current) => ({
        ...current,
        schedule: { kind, timezone, hour: time.hour, minute: time.minute },
      }));
      return;
    }
    setDefinition((current) => ({
      ...current,
      schedule: {
        kind,
        timezone,
        daysOfWeek: current.schedule.kind === "weekly" ? current.schedule.daysOfWeek : [1],
        hour: time.hour,
        minute: time.minute,
      },
    }));
  };

  const changeScheduledTime = (field: "hour" | "minute", value: number) => {
    setDefinition((current) => {
      if (current.schedule.kind === "manual") return current;
      return {
        ...current,
        schedule: { ...current.schedule, [field]: value },
      };
    });
  };

  const toggleWeekday = (day: number) => {
    setDefinition((current) => {
      if (current.schedule.kind !== "weekly") return current;
      const selected = current.schedule.daysOfWeek.includes(day);
      const daysOfWeek = selected
        ? current.schedule.daysOfWeek.filter((value) => value !== day)
        : [...current.schedule.daysOfWeek, day].sort();
      if (daysOfWeek.length === 0) return current;
      return { ...current, schedule: { ...current.schedule, daysOfWeek } };
    });
  };

  const requestPreview = async () => {
    setPreviewBusy(true);
    setPreviewError("");
    try {
      setPreview(await props.onPreview(definition.schedule));
    } catch (error) {
      setPreview(null);
      setPreviewError(error instanceof Error ? error.message : t("scheduled_tasks.error_generic"));
    } finally {
      setPreviewBusy(false);
    }
  };

  return (
    <form
      className="space-y-5"
      data-scheduled-task-editor
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) void props.onSave(definition);
      }}
    >
      <section className="space-y-5 rounded-2xl border border-border p-5" aria-labelledby="scheduled-task-details-heading">
        <div>
          <h3 id="scheduled-task-details-heading" className="text-sm font-medium">{t("scheduled_tasks.task_details")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t("scheduled_tasks.task_details_copy")}</p>
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="scheduled-task-name">{t("scheduled_tasks.name")}</Label>
            <Input
              id="scheduled-task-name"
              data-testid="scheduled-task-name"
              value={definition.name}
              maxLength={120}
              required
              placeholder={t("scheduled_tasks.name_placeholder")}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDefinition((current) => ({ ...current, name: value }));
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="scheduled-task-description">{t("scheduled_tasks.description")}</Label>
            <Input
              id="scheduled-task-description"
              value={definition.description}
              maxLength={2_000}
              placeholder={t("scheduled_tasks.description_placeholder")}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDefinition((current) => ({ ...current, description: value }));
              }}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="scheduled-task-prompt">{t("scheduled_tasks.prompt")}</Label>
          <Textarea
            id="scheduled-task-prompt"
            data-testid="scheduled-task-prompt"
            className="min-h-32 resize-y"
            value={definition.prompt}
            required
            placeholder={t("scheduled_tasks.prompt_placeholder")}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDefinition((current) => ({ ...current, prompt: value }));
            }}
          />
          <p className="text-xs text-muted-foreground">{t("scheduled_tasks.prompt_hint")}</p>
        </div>
      </section>

      <section className="space-y-5 rounded-2xl border border-border p-5" aria-labelledby="scheduled-task-schedule-heading">
        <div>
          <h3 id="scheduled-task-schedule-heading" className="text-sm font-medium">{t("scheduled_tasks.schedule")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t("scheduled_tasks.schedule_copy")}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="scheduled-task-frequency">{t("scheduled_tasks.frequency")}</Label>
            <select
              id="scheduled-task-frequency"
              data-testid="scheduled-task-frequency"
              className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm"
              value={definition.schedule.kind}
              onChange={(event) => changeScheduleKind(event.currentTarget.value as ScheduledTaskSchedule["kind"])}
            >
              <option value="manual">{t("scheduled_tasks.manual")}</option>
              <option value="daily">{t("scheduled_tasks.daily")}</option>
              <option value="weekly">{t("scheduled_tasks.weekly")}</option>
            </select>
          </div>
          {definition.schedule.kind === "manual" ? (
            <div className="flex items-end">
              <p className="pb-2 text-sm text-muted-foreground">{t("scheduled_tasks.manual_copy")}</p>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="scheduled-task-time">{t("scheduled_tasks.time")}</Label>
                <Input
                  id="scheduled-task-time"
                  data-testid="scheduled-task-time"
                  type="time"
                  value={`${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`}
                  onChange={(event) => {
                    const [hour, minute] = event.currentTarget.value.split(":").map(Number);
                    if (Number.isFinite(hour) && Number.isFinite(minute)) {
                      changeScheduledTime("hour", hour);
                      changeScheduledTime("minute", minute);
                    }
                  }}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="scheduled-task-timezone">{t("scheduled_tasks.timezone")}</Label>
                <Input
                  id="scheduled-task-timezone"
                  data-testid="scheduled-task-timezone"
                  value={definition.schedule.timezone}
                  placeholder="Europe/Berlin"
                  required
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDefinition((current) => ({
                      ...current,
                      schedule: { ...current.schedule, timezone: value },
                    }));
                  }}
                />
                <p className="text-xs text-muted-foreground">{t("scheduled_tasks.timezone_hint")}</p>
              </div>
            </>
          )}
        </div>

        {definition.schedule.kind === "weekly" ? (
          <div className="space-y-2">
            <Label>{t("scheduled_tasks.weekdays")}</Label>
            <div className="flex flex-wrap gap-2" aria-label={t("scheduled_tasks.weekdays")}>
              {WEEKDAYS.map((day) => {
                const selected = definition.schedule.kind === "weekly"
                  && definition.schedule.daysOfWeek.includes(day.value);
                return (
                  <Button
                    key={day.value}
                    type="button"
                    size="sm"
                    variant={selected ? "default" : "outline"}
                    aria-pressed={selected}
                    onClick={() => toggleWeekday(day.value)}
                  >
                    {weekdayLabel(day.day)}
                  </Button>
                );
              })}
            </div>
          </div>
        ) : null}

        {definition.schedule.kind !== "manual" ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" size="sm" disabled={previewBusy} onClick={() => void requestPreview()}>
                {previewBusy ? t("scheduled_tasks.preview_loading") : t("scheduled_tasks.preview")}
              </Button>
              <span className="text-xs text-muted-foreground">{t("scheduled_tasks.preview_server_hint")}</span>
            </div>
            {previewError ? <p role="alert" className="text-sm text-destructive">{previewError}</p> : null}
            {preview ? (
              <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5" data-testid="scheduled-task-preview">
                {preview.occurrences.map((occurrence, index) => (
                  <li key={`${occurrence}:${index}`} className="rounded-xl bg-muted/60 px-3 py-2 text-xs">
                    <span className="block font-medium">{t("scheduled_tasks.occurrence", { count: index + 1 })}</span>
                    <time dateTime={new Date(occurrence).toISOString()}>{new Date(occurrence).toLocaleString()}</time>
                  </li>
                ))}
              </ol>
            ) : null}
          </>
        ) : null}

        <div className="flex items-start gap-2 rounded-xl bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
          <Clock3 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{t("scheduled_tasks.limit_copy")}</span>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-border" aria-labelledby="scheduled-task-advanced-heading">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-muted/40"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((current) => !current)}
        >
          <span className="flex min-w-0 items-center gap-3">
            <Settings2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0">
              <span id="scheduled-task-advanced-heading" className="block text-sm font-medium">{t("scheduled_tasks.advanced_settings")}</span>
              <span className="block text-xs text-muted-foreground">{t("scheduled_tasks.advanced_settings_copy")}</span>
            </span>
          </span>
          <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${advancedOpen ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
        {advancedOpen ? (
          <div className="space-y-4 border-t border-border px-5 py-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="scheduled-task-provider">{t("scheduled_tasks.provider")}</Label>
                <Input
                  id="scheduled-task-provider"
                  value={definition.model.providerId ?? ""}
                  placeholder={t("scheduled_tasks.default_value")}
                  onChange={(event) => {
                    const value = event.currentTarget.value.trim() || null;
                    setDefinition((current) => ({
                      ...current,
                      model: { ...current.model, providerId: value },
                    }));
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="scheduled-task-model">{t("scheduled_tasks.model")}</Label>
                <Input
                  id="scheduled-task-model"
                  value={definition.model.modelId ?? ""}
                  placeholder={t("scheduled_tasks.default_value")}
                  onChange={(event) => {
                    const value = event.currentTarget.value.trim() || null;
                    setDefinition((current) => ({
                      ...current,
                      model: { ...current.model, modelId: value },
                    }));
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="scheduled-task-agent">{t("scheduled_tasks.agent")}</Label>
                <Input
                  id="scheduled-task-agent"
                  value={definition.model.agent ?? ""}
                  placeholder={t("scheduled_tasks.default_value")}
                  onChange={(event) => {
                    const value = event.currentTarget.value.trim() || null;
                    setDefinition((current) => ({
                      ...current,
                      model: { ...current.model, agent: value },
                    }));
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="scheduled-task-timeout">{t("scheduled_tasks.timeout_minutes")}</Label>
                <Input
                  id="scheduled-task-timeout"
                  type="number"
                  min={1}
                  max={1_440}
                  value={Math.round(definition.maximumRuntimeMs / 60_000)}
                  onChange={(event) => {
                    const value = Math.max(1, Number(event.currentTarget.value)) * 60_000;
                    setDefinition((current) => ({
                      ...current,
                      maximumRuntimeMs: value,
                    }));
                  }}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t("scheduled_tasks.fixed_policies")}</p>
          </div>
        ) : null}
      </section>

      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <Button type="button" variant="outline" onClick={props.onCancel}>{t("common.cancel")}</Button>
        <Button type="submit" data-testid="scheduled-task-save" disabled={!canSave || props.busy}>
          {props.busy ? t("scheduled_tasks.saving") : props.submitLabel}
        </Button>
      </div>
    </form>
  );
}
