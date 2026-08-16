import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  canRefreshInvitationRole,
  getOrgAccessFlags,
  isAssignableOrgRole,
  roleIncludesCanonicalRole,
  type DenOrgRole,
} from "../app/(den)/_lib/den-org";

function read(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function orgRole(role: string, protectedRole = false, builtIn = true): DenOrgRole {
  return {
    id: role,
    role,
    permission: {},
    builtIn,
    protected: protectedRole,
    createdAt: null,
    updatedAt: null,
  };
}

describe("cloud super-admin role hierarchy", () => {
  test("derives canonical access flags without collapsing custom role strings", () => {
    const owner = getOrgAccessFlags("member", true);
    expect(owner.canonicalRole).toBe("owner");
    expect(owner.isAdmin).toBe(true);
    expect(owner.isSuperAdmin).toBe(false);
    expect(owner.canManageSettings).toBe(true);
    expect(owner.canManageRoles).toBe(true);
    expect(owner.canTransferOwnership).toBe(true);

    const superAdmin = getOrgAccessFlags("qa-reviewer, super-admin", false);
    expect(superAdmin.canonicalRole).toBe("super-admin");
    expect(superAdmin.isAdmin).toBe(true);
    expect(superAdmin.canManageSettings).toBe(true);
    expect(superAdmin.canManageRoles).toBe(true);
    expect(superAdmin.canTransferOwnership).toBe(false);
    expect(roleIncludesCanonicalRole("qa-reviewer, super-admin", "super-admin")).toBe(true);

    const admin = getOrgAccessFlags("admin, qa-reviewer", false);
    expect(admin.canonicalRole).toBe("admin");
    expect(admin.isAdmin).toBe(true);
    expect(admin.canViewSettings).toBe(true);
    expect(admin.canManageSettings).toBe(false);
    expect(admin.canManageRoles).toBe(false);
    expect(admin.canInviteMembers).toBe(true);
    expect(admin.canRemoveMembers).toBe(true);
    expect(admin.canStartSeatCheckout).toBe(true);

    const custom = getOrgAccessFlags("qa-reviewer", false);
    expect(custom.canonicalRole).toBe("member");
    expect(custom.isAdmin).toBe(false);
    expect(custom.canViewSettings).toBe(false);
  });

  test("keeps owner unassignable while allowing super-admin, admin, member, and custom roles", () => {
    expect(isAssignableOrgRole(orgRole("owner"))).toBe(false);
    expect(isAssignableOrgRole(orgRole("owner", true))).toBe(false);
    expect(isAssignableOrgRole(orgRole("super-admin", true))).toBe(true);
    expect(isAssignableOrgRole(orgRole("admin", true))).toBe(true);
    expect(isAssignableOrgRole(orgRole("member", true))).toBe(true);
    expect(isAssignableOrgRole(orgRole("qa-reviewer", false, false))).toBe(true);
    expect(isAssignableOrgRole(orgRole("qa-reviewer", true, false))).toBe(false);
  });

  test("allows admin invitation refresh only for pending member roles", () => {
    const admin = getOrgAccessFlags("admin", false);
    const superAdmin = getOrgAccessFlags("super-admin", false);

    expect(canRefreshInvitationRole("member", admin)).toBe(true);
    expect(canRefreshInvitationRole("admin", admin)).toBe(false);
    expect(canRefreshInvitationRole("super-admin", admin)).toBe(false);
    expect(canRefreshInvitationRole("qa-reviewer", admin)).toBe(false);
    expect(canRefreshInvitationRole("qa-reviewer", superAdmin)).toBe(true);
  });

  test("exposes exact admin sidebar destinations for Manage, Observability, and Team", () => {
    const shell = read("../app/(den)/dashboard/_components/org-dashboard-shell.tsx");

    for (const label of ["Collections", "Plugin Directory", "Connectors", "Sources", "Models", "OpenWork Models", "Bring your Own Keys", "Workflow Runs", "Analytics", "Members", "Settings"]) {
      expect(shell).toContain(`label: "${label}"`);
    }

    for (const label of ["General", "Diagnostics", "Brand appearance", "Desktop Policies", "Billing", "API Keys", "SSO", "SCIM", "Tool Tester"]) {
      expect(shell).toContain(`label: "${label}"`);
    }

    expect(shell).toContain('label: "Work"');
    expect(shell).toContain('label: "Manage"');
    expect(shell).toContain('label: "Observability"');
    expect(shell).toContain('label: "Team"');
    expect(shell).not.toContain('label: "Extensions"');
    expect(shell).not.toContain('label: "Your Connections"');
    expect(shell).toContain("access.canViewSettings");
    expect(shell).toContain("access.isAdmin && activeOrg");
  });

  test("keeps admins read-only across Settings while super-admins inherit mutation flags", () => {
    const orgSettings = read("../app/(den)/dashboard/_components/org-settings-screen.tsx");
    const diagnostics = read("../app/(den)/dashboard/_components/diagnostics-screen.tsx");
    const diagnosticCard = read("../app/(den)/dashboard/_components/egress-diagnostics-card.tsx");
    const brand = read("../app/(den)/dashboard/_components/brand-appearance-screen.tsx");
    const desktopPolicies = read("../app/(den)/dashboard/_components/desktop-policies-screen.tsx");
    const desktopPolicyEditor = read("../app/(den)/dashboard/_components/desktop-policy-editor-screen.tsx");
    const billing = read("../app/(den)/dashboard/_components/billing-dashboard-screen.tsx");
    const apiKeys = read("../app/(den)/dashboard/_components/api-keys-screen.tsx");
    const sso = read("../app/(den)/dashboard/_components/sso-screen.tsx");
    const scim = read("../app/(den)/dashboard/_components/scim-screen.tsx");

    expect(getOrgAccessFlags("super-admin", false).canManageSettings).toBe(true);
    expect(getOrgAccessFlags("admin", false).canManageSettings).toBe(false);
    expect(orgSettings).toContain("const canManageSettings = access.canManageSettings");
    expect(orgSettings).toContain("Admins can view settings here. Owners and super-admins can change them.");
    expect(orgSettings).toContain("disabled={!canManageDesktopVersions || requiresServerUpgrade}");
    expect(diagnostics).toContain("canView={access.canViewSettings} canManage={access.canManageSettings}");
    expect(diagnosticCard).toContain("disabled={!canManage || loading || !available}");
    expect(diagnosticCard).toContain("Only workspace owners and super-admins can run this diagnostic.");
    expect(brand).toContain("const canManageBrandAppearance = access.canManageSettings");
    expect(brand).toContain("disabled={!canManageBrandAppearance}");
    expect(desktopPolicies).toContain("const canManage = access.canManageSettings");
    expect(desktopPolicies).toContain("disabled={!canManage || deleting}");
    expect(desktopPolicyEditor).toContain("const formDisabled = saving || togglingEnabled || !canManage");
    expect(desktopPolicyEditor).toContain("disabled={!canManage || togglingEnabled}");
    expect(billing).toContain("const canManageBillingSettings = access.canManageSettings");
    expect(billing).toContain("disabled={!canManageBillingSettings}");
    expect(apiKeys).toContain("!access.canViewSettings");
    expect(apiKeys).toContain("!access.canManageApiKeys");
    expect(apiKeys).toContain("disabled={!access.canManageApiKeys}");
    expect(sso).toContain("!access.canViewSettings");
    expect(sso).toContain("!access.canManageSso");
    expect(sso).toContain("disabled={ssoFormDisabled}");
    expect(sso).toContain("Client secrets are never returned by Den.");
    expect(scim).toContain("!access.canViewSettings");
    expect(scim).toContain("!access.canManageScim");
    expect(scim).toContain("disabled={!access.canManageScim || !connection}");
  });

  test("supports owner-only transfer to active super-admin members", () => {
    const provider = read("../app/(den)/dashboard/_providers/org-dashboard-provider.tsx");
    const members = read("../app/(den)/dashboard/_components/manage-members-screen.tsx");

    expect(provider).toContain("transferOwnership: (memberId: string) => Promise<void>");
    expect(provider).toContain("/transfer-ownership`");
    expect(provider).toContain("targetAccess.isSuperAdmin");
    expect(provider).toContain("Only the workspace owner can transfer ownership.");
    expect(members).toContain("canTransferOwnershipToMember = access.canTransferOwnership && !isInvited && memberAccess.isSuperAdmin");
    expect(members).toContain("becomes the sole owner, and your account becomes a super-admin");
    expect(members).toContain('mutationBusy === "transfer-ownership"');
  });
});
