import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LockKeyhole, ScrollText } from "lucide-react";
import { getAuditLogsRoute, getOrgAccessFlags } from "../app/(den)/_lib/den-org";
import { buildDashboardNavSections, flattenNavigationForSearch } from "../app/(den)/dashboard/_lib/dashboard-navigation";
import { auditDashboard } from "./audit-logs-fixtures";

const root = join(import.meta.dir, "../app/(den)");
test("audit uses one canonical route outside the redirecting admin layout", () => {
  for (const slug of [null, undefined, "workspace-a", "workspace-b"]) expect(getAuditLogsRoute(slug)).toBe("/dashboard/audit-logs");
  expect(existsSync(join(root, "dashboard/audit-logs/page.tsx"))).toBe(true);
  expect(existsSync(join(root, "dashboard/(admin)/audit-logs/page.tsx"))).toBe(false);
  const shell = readFileSync(join(root, "dashboard/_components/org-dashboard-shell.tsx"), "utf8");
  expect(shell).toContain('if (pathname.startsWith(getAuditLogsRoute(orgSlug))) {\n    return "Audit logs";');
});

test.each(["owner", "super-admin", "admin", "member", "custom-role"])("audit discovery and palette stay visible for %s with honest access", (role) => {
  const fixture = auditDashboard("org-a", role);
  if (!fixture.orgContext) throw new Error("Missing context");
  const access = getOrgAccessFlags(role, role === "owner");
  for (const orgMode of ["multi_org", "single_org"] satisfies ("multi_org" | "single_org")[]) {
    const sections = buildDashboardNavSections({ orgSlug: "workspace", access, capabilities: fixture.orgContext.capabilities, orgMode, runtimeConfigLoaded: true });
    const audit = sections.find((section) => section.label === "Observability")?.items.find((item) => item.label === "Audit logs");
    expect(audit?.href).toBe("/dashboard/audit-logs");
    expect(audit?.icon).toBe(access.isAdmin ? ScrollText : LockKeyhole);
    expect(audit?.badge).toBe(access.isAdmin ? undefined : "Admin access");
    expect(flattenNavigationForSearch(sections).find((item) => item.href === audit?.href)?.keywords).toContain("changes");
  }
});
