import type { AdminControlCenter, ControlCenterSectionKey } from "@openwork/types/den/admin-control-center";

export const count = (value: number) => new Intl.NumberFormat().format(Math.round(value));
export const compact = (value: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
export const percent = (value: number | null, digits = 0) => value === null ? "—" : `${(value * 100).toFixed(digits)}%`;
export const decimal = (value: number | null, digits = 1) => value === null ? "—" : value.toFixed(digits);
/** "Oct 19" for a UTC date key. */
export const shortDate = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
export const weekLabel = (week: string) => `${shortDate(week)}–${shortDate(new Date(Date.parse(`${week}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10))}`;

export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return "Not computed yet";
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `Updated ${hours} h ago` : `Updated ${Math.round(hours / 24)} d ago`;
}

/** Percent change, or null when there is nothing to compare with. */
export function change(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 100);
}

export const FAILURE_RATE_THRESHOLD = 0.12;
export const INVITE_ACTIVATION_THRESHOLD = 0.3;
/** Below this many invited members the activation share is noise. */
export const INVITE_MIN_MEMBERS = 10;
export const CONNECTOR_ERROR_THRESHOLD = 0.15;
/** Below this many calls a connector's error rate is noise. */
export const CONNECTOR_MIN_CALLS = 50;

export type Signal = { id: string; tone: "warn" | "info"; text: string; section: ControlCenterSectionKey };

/** What needs attention, from whichever snapshots are available. */
export function controlCenterSignals(view: AdminControlCenter): Signal[] {
  const signals: Signal[] = [];
  const { pulse, invitations, lifecycle, sharing, revenue } = view.sections;
  const failureRate = pulse.data?.failures.failureRate ?? null;
  if (failureRate !== null && failureRate > FAILURE_RATE_THRESHOLD) {
    signals.push({ id: "failures", tone: "warn", section: "pulse", text: `${percent(failureRate, 1)} of tasks failed in the last 7 days, above the ${percent(FAILURE_RATE_THRESHOLD)} threshold.` });
  }
  const invited = invitations.data;
  const inviteActivation = invited && invited.joinedThroughInvite >= INVITE_MIN_MEMBERS ? invited.joinedRanTaskWithin7Days / invited.joinedThroughInvite : null;
  if (inviteActivation !== null && inviteActivation < INVITE_ACTIVATION_THRESHOLD) {
    signals.push({ id: "invites", tone: "warn", section: "invitations", text: `Only ${percent(inviteActivation)} of invited members ran a task within 7 days of joining.` });
  }
  for (const connector of sharing.data?.connectors ?? []) {
    if (connector.calls >= CONNECTOR_MIN_CALLS && connector.errorRate !== null && connector.errorRate > CONNECTOR_ERROR_THRESHOLD) {
      signals.push({ id: `connector:${connector.name}`, tone: "warn", section: "sharing", text: `${connector.name} calls fail ${percent(connector.errorRate)} of the time.` });
    }
  }
  const lastWeek = lifecycle.data?.weeks.at(-1);
  if (lastWeek?.gainsVsLosses != null && lastWeek.gainsVsLosses < 1) {
    signals.push({ id: "gains", tone: "warn", section: "lifecycle", text: `More people were lost than gained in the week of ${weekLabel(lastWeek.week)} (${decimal(lastWeek.gainsVsLosses, 2)} gained per person lost).` });
  }
  if (revenue.data && revenue.data.pastDue > 0) {
    signals.push({ id: "past-due", tone: "warn", section: "revenue", text: `${count(revenue.data.pastDue)} paid ${revenue.data.pastDue === 1 ? "plan is" : "plans are"} past due.` });
  }
  const failed = Object.values(view.sections).filter((section) => section.error !== null).length;
  if (failed > 0) {
    signals.push({ id: "refresh", tone: "info", section: "pulse", text: `${failed} ${failed === 1 ? "section" : "sections"} could not refresh and show the last good numbers.` });
  }
  return signals;
}
