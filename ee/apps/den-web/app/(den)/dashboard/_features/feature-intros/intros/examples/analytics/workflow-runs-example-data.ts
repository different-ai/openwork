/** Sample data only: no API calls (DESIGN.md I7). Rows follow the real Workflow runs list. */

export const workflowRunsExampleRows: ReadonlyArray<{ title: string; when: string; status: "succeeded" | "failed" }> = [
  { title: "Weekly sales digest", when: "Today, 9:00 AM", status: "succeeded" },
  { title: "One-off task", when: "Today, 8:42 AM", status: "succeeded" },
  { title: "Invoice follow-up", when: "Yesterday, 4:15 PM", status: "failed" },
];
