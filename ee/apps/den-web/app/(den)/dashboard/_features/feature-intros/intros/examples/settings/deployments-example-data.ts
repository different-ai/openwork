/**
 * Sample data only: no API calls (DESIGN.md I7). Status and check names are the
 * ones the Deployments page shows (`deploymentStatus`, CHECK_LABELS); details are
 * shortened to fit the example column.
 */
export const deploymentsExample = {
  name: "Production",
  address: "openwork.acme.com",
  where: "AWS · 123456789012 · us-east-1",
  version: "0.18.4",
  status: "Operational",
  reported: "Last report 3 min ago",
};

export const deploymentsExampleChecks: ReadonlyArray<{ label: string; detail: string }> = [
  { label: "API", detail: "142 ms" },
  { label: "Database connection", detail: "Connected" },
  { label: "Backups", detail: "Within the last hour" },
  { label: "HTTPS certificate", detail: "61 days left" },
];
