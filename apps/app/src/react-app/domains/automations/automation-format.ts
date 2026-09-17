import type { AutomationRun, AutomationSchedule } from "@openwork/types/automations";

type RunReceiptState = Pick<AutomationRun, "status" | "error" | "attemptCount" | "startedAt">;

type RunNotice = {
  variant: "default" | "destructive";
  title: string;
  message: string;
};

export function automationRunNotice(run: RunReceiptState): RunNotice | null {
  if (!run.error) return null;
  if (run.status === "skipped" && run.error.code === "runner_unavailable") {
    if (run.attemptCount === 0 && run.startedAt == null) {
      return {
        variant: "default",
        title: "Run missed",
        message: `This occurrence never started. ${run.error.message.trim() || "The desktop runner was unavailable."} Keep OpenWork open, signed in, and your computer awake and connected for future runs.`,
      };
    }
    return {
      variant: "destructive",
      title: "Run interrupted",
      message: `An execution attempt or start was recorded for this run. Recorded cause: ${run.error.message}`,
    };
  }
  return {
    variant: "destructive",
    title: run.status === "failed" && run.error.code === "lease_lost" ? "Run interrupted" : run.error.code,
    message: run.error.message,
  };
}

export function runStatusLabel(run: RunReceiptState) {
  const notice = automationRunNotice(run);
  if (notice && ((run.status === "skipped" && run.error?.code === "runner_unavailable")
    || (run.status === "failed" && run.error?.code === "lease_lost"))) {
    return notice.title;
  }
  if (run.status === "skipped" && (run.error?.code === "model_access_lost" || run.error?.code === "provider_unavailable")) {
    return "Skipped — model unavailable";
  }
  return run.status === "succeeded" ? "Completed" : run.status.replaceAll("_", " ");
}

const SUNDAY_UTC = Date.UTC(2024, 0, 7);

export function formatAutomationWeekdays(daysOfWeek: number[], locales?: Intl.LocalesArgument) {
  const formatter = new Intl.DateTimeFormat(locales, {
    weekday: "short",
    timeZone: "UTC",
  });

  return daysOfWeek
    .map((day) => formatter.format(new Date(SUNDAY_UTC + day * 24 * 60 * 60 * 1_000)))
    .join(", ");
}

export function formatAutomationTime(value: number | null | undefined) {
  return typeof value === "number" ? new Date(value).toLocaleString() : "—";
}

export function formatAutomationSchedule(schedule: AutomationSchedule) {
  if (schedule.kind === "once") {
    return `Once · ${formatAutomationTime(schedule.at)} · ${schedule.timezone}`;
  }
  const time = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  if (schedule.kind === "daily") return `Daily · ${time} · ${schedule.timezone}`;
  return `Weekly · ${formatAutomationWeekdays(schedule.daysOfWeek)} · ${time} · ${schedule.timezone}`;
}
