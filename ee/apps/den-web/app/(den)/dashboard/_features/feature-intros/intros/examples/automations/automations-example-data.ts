/** Sample data only: no API calls (DESIGN.md I7). Groups and lines follow the real My Automations list. */

export type AutomationsExampleItem = {
  name: string;
  schedule: string;
  status: string;
  placement: "desktop" | "cloud";
};

export const automationsExampleGroups: ReadonlyArray<{ title: string; items: readonly AutomationsExampleItem[] }> = [
  {
    title: "Running now",
    items: [{ name: "Invoice follow-up", schedule: "Weekly, Friday, 4:00 PM", status: "Started 2 minutes ago", placement: "cloud" }],
  },
  {
    title: "Scheduled",
    items: [
      { name: "Weekly sales digest", schedule: "Weekly, Monday, 9:00 AM", status: "Last run succeeded", placement: "cloud" },
      { name: "Morning inbox triage", schedule: "Daily, 8:30 AM", status: "Next tomorrow, 8:30 AM", placement: "desktop" },
    ],
  },
];
