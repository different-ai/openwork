import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const screenPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/org-settings-screen.tsx", import.meta.url),
);
const sectionPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/organization-settings-section.tsx", import.meta.url),
);

describe("organization settings dashboard section", () => {
  test("renders the existing form through a dedicated labelled section component", () => {
    const screen = readFileSync(screenPath, "utf8");
    const section = readFileSync(sectionPath, "utf8");

    expect(screen).toContain('import { OrganizationSettingsSection } from "./organization-settings-section"');
    expect(screen).toContain("<OrganizationSettingsSection");
    expect(section).toContain("export function OrganizationSettingsSection");
    expect(section).toContain('<section\n      aria-labelledby="organization-settings-section-title"');
    expect(section).toContain('data-testid="organization-settings-section"');
    expect(section).toContain('id="organization-settings-section-title"');
    expect(section).toContain("Organization settings");
    expect(section).toContain('<form className="grid min-w-0 grid-cols-1 gap-6" onSubmit={onSubmit}>');
  });

  test("preserves controlled values, validation, permissions, mutation feedback, and error wiring", () => {
    const screen = readFileSync(screenPath, "utf8");
    const section = readFileSync(sectionPath, "utf8");

    expect(screen).toContain("setOrgNameDraft(orgContext.organization.name)");
    expect(screen).toContain("allowedEmailDomains: domainRestrictionsEnabled");
    expect(screen).toContain("requireSso: requireSsoEnabled");
    expect(screen).toContain("await updateOrganizationSettings({");
    expect(screen).toContain("error instanceof Error");
    expect(screen).toContain("success={pageSuccess}");
    expect(screen).toContain("onSubmit={handleSaveSettings}");
    expect(section).toContain("value={organizationName}");
    expect(section).toContain("minLength={2}");
    expect(section).toContain("maxLength={120}");
    expect(section).toContain("required");
    expect(section).toContain("disabled={!canManageSettings}");
    expect(section).toContain("loading={saving}");
    expect(section).toContain("{error ? <DenNotice message={error} /> : null}");
    expect(section).toContain("{success}");
  });
});
