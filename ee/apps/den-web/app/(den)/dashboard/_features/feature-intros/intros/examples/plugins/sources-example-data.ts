/** Sample data only: no API calls (DESIGN.md I7). */

/** A connected GitHub account and the repositories it brings plugins from. */
export const sourcesExampleAccount = { login: "@acme", connectedBy: "Connected by Ada Park" };

export const sourcesExampleRepos: ReadonlyArray<{ repo: string; plugins: string; synced: string }> = [
  { repo: "acme/sales-plugins", plugins: "2 plugins", synced: "Updated 5 min ago" },
  { repo: "acme/release-tools", plugins: "1 plugin", synced: "Updated yesterday" },
];

/** What happens after someone changes a connected repository. */
export const sourcesExampleUpdate = { sentence: "New version on main", result: "Sales playbook updated" };
