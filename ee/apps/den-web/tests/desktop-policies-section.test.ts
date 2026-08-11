import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

function readDashboardComponent(name: string) {
  return readFileSync(
    fileURLToPath(new URL(`../app/(den)/dashboard/_components/${name}`, import.meta.url)),
    "utf8",
  );
}

describe("Desktop Policies dashboard section", () => {
  test("extracts policy content into one clearly headed section", () => {
    const screen = readDashboardComponent("desktop-policies-screen.tsx");
    const section = readDashboardComponent("desktop-policies-section.tsx");

    expect(screen).toContain("<DesktopPoliciesSection />");
    expect(screen).not.toContain("useOrgDesktopPolicies");
    expect(screen).toContain('title="Desktop controls"');
    expect(screen).not.toContain('title="Desktop policies"');
    expect(section).toContain("export function DesktopPoliciesSection");
    expect(section).toContain('<section\n      aria-labelledby="desktop-policies-section-heading"');
    expect(section).toContain('<h2 id="desktop-policies-section-heading"');
    expect(section).toContain('data-testid="desktop-policies-section"');
    expect(section).toContain("Desktop policies");
    expect(screen).toContain("Control which desktop capabilities are available to the whole org, specific members, or teams.");
  });

  test("keeps policy data, permissions, actions, and asynchronous states in the section", () => {
    const section = readDashboardComponent("desktop-policies-section.tsx");

    expect(section.match(/useOrgDesktopPolicies\(orgId\)/g)).toHaveLength(1);
    expect(section).toContain("const canManage = access.canManageSettings");
    expect(section).toContain("getNewDesktopPolicyRoute(orgSlug)");
    expect(section).toContain("getDesktopPolicyRoute(orgSlug, policy.id)");
    expect(section).toContain('runReauthableAction("delete-desktop-policy"');
    expect(section).toContain('feature="Desktop policy management"');
    expect(section).toContain("Loading desktop policies...");
    expect(section).toContain("No desktop policies.");
    expect(section).toContain('setPageSuccess("Desktop policy deleted.")');
    expect(section).toContain('"Failed to delete desktop policy."');
    expect(section).toContain("pageError");
    expect(section).toContain("pageSuccess");
    expect(section).toContain('{canManage ? "Edit" : "View"}');
    expect(section).toContain("{policy.isEnabled ? \"Yes\" : \"No\"}");
    expect(section).toContain('{policy.isDefault ? "Fallback" : policy.priority}');
    expect(section).toContain("disabled={!canManage || deleting}");
  });
});
