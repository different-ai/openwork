export type TeamAgentsExampleRow = { title: string; choice: string; detail: string };

export const teamAgentsExampleTeam = "Contractors";

export const teamAgentsExampleRows: readonly TeamAgentsExampleRow[] = [
  { title: "Run commands", choice: "Ask first", detail: "Always allowed: git *, npm test" },
  { title: "Edit files", choice: "Allow", detail: "Same as Everyone" },
  { title: "Use local MCP servers", choice: "Blocked", detail: "Changed for this team" },
];

export const teamBrowserExampleRows: readonly TeamAgentsExampleRow[] = [
  { title: "Open websites", choice: "Ask first", detail: "The person approves each new site" },
  { title: "docs.acme.com", choice: "Always allowed", detail: "Opens without asking" },
  { title: "*.filesharing.example", choice: "Always blocked", detail: "Never loads, the browser says why" },
];
