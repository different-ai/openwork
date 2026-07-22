import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const cardPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/egress-diagnostics-card.tsx", import.meta.url),
);
const settingsPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/org-settings-screen.tsx", import.meta.url),
);
const diagnosticsPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/diagnostics-screen.tsx", import.meta.url),
);
const shellPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/org-dashboard-shell.tsx", import.meta.url),
);
const routePath = fileURLToPath(
  new URL("../../den-api/src/routes/org/egress-diagnostics.ts", import.meta.url),
);

describe("Den egress diagnostic settings flow", () => {
  test("presents the controlled multi-step run on the dedicated Diagnostics page", () => {
    const card = readFileSync(cardPath, "utf8");
    const settings = readFileSync(settingsPath, "utf8");
    const diagnostics = readFileSync(diagnosticsPath, "utf8");
    const shell = readFileSync(shellPath, "utf8");

    expect(settings).not.toContain("EgressDiagnosticsCard");
    expect(diagnostics).toContain("<EgressDiagnosticsCard canRun />");
    expect(shell).toContain('{ href: getDiagnosticsRoute(activeOrg.slug), label: "Diagnostics" }');
    expect(card).toContain("Run egress diagnostic");
    expect(card).toContain("Open support trace");
    expect(card).toContain("Suggested owner:");
    expect(card).toContain("Remote diagnostic references");
    expect(card).toContain('requestJson("/v1/diagnostics/egress", { method: "GET" }');
    expect(card).toContain('requestJson("/v1/diagnostics/egress", { method: "POST" }');
  });

  test("keeps the destination fixed while storing the synthetic token in Den", () => {
    const card = readFileSync(cardPath, "utf8");
    const route = readFileSync(routePath, "utf8");

    expect(card).toContain("<DenInput");
    expect(card).toContain('type="password"');
    expect(card).toContain('requestJson("/v1/diagnostics/egress/token"');
    expect(card).toContain("Den encrypts the token for this organization");
    expect(card).toContain("Change token");
    expect(route).toContain("env.diagnostics.origin");
    expect(route).toContain("env.diagnostics.bearerToken");
    expect(route).toContain("OrganizationDiagnosticCredentialTable");
    expect(route).toContain('c.req.json');
    expect(route).toContain('orgRoleRoute(["admin"])');
  });
});
