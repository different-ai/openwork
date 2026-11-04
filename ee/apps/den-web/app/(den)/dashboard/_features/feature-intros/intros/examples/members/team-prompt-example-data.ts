/** Sample data only: no API calls (DESIGN.md I7). In the order agents receive them: Everyone's first. */

export const teamPromptExampleRows: ReadonlyArray<{ title: string; state: string; content: string }> = [
  {
    title: "Prompt for everyone",
    state: "Applies first",
    content: "Write in plain English for customers. Never share pricing that isn't on the website.",
  },
  {
    title: "Support's prompt",
    state: "Updated today",
    content: "Link the help center article you used. Escalate refunds over $500 to #support-leads.",
  },
];
