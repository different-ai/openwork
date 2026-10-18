import type { AutomationCalendarItem, CalendarEvent } from "@openwork/calendar";

export type CalendarSelection =
  | { kind: "automation"; automationId: string; itemKey: string | null }
  | { kind: "meeting"; key: string }
  | null;

/** Detail and shared chat context must agree on what is visible, never an offscreen cached selection. */
export function visibleCalendarSelection(input: {
  selection: CalendarSelection;
  selectionScope: string | undefined;
  scope: string;
  automations: readonly { automation: { id: string } }[];
  items: readonly AutomationCalendarItem[];
  meetings: readonly CalendarEvent[];
  layers: { automations: boolean; meetings: boolean };
}): CalendarSelection {
  const selected = input.selection;
  if (!selected || input.selectionScope !== input.scope) return null;
  if (selected.kind === "meeting") return input.layers.meetings && input.meetings.some((event) => event.key === selected.key) ? selected : null;
  if (!input.layers.automations || !input.automations.some((item) => item.automation.id === selected.automationId)) return null;
  return selected.itemKey === null || input.items.some((item) => item.key === selected.itemKey) ? selected : null;
}
