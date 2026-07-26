import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dashboardComponents = join(import.meta.dir, "../app/(den)/dashboard/_components");
const editor = readFileSync(join(dashboardComponents, "skill-editor-screen.tsx"), "utf8");
const detail = readFileSync(join(dashboardComponents, "skill-detail-screen.tsx"), "utf8");
const data = readFileSync(join(dashboardComponents, "skill-data.tsx"), "utf8");

describe("Den skill CRUD UI contract", () => {
  test("exposes the complete create and edit fields", () => {
    expect(editor).toContain('placeholder="e.g. customer-research"');
    expect(editor).toContain('placeholder="When should an agent use this skill?"');
    expect(editor).toContain('placeholder="# Instructions\\n\\nDescribe the complete workflow..."');
    expect(editor).toContain('"Create skill"');
    expect(editor).toContain('"Save changes"');
  });

  test("shows the complete body and requires a named delete confirmation", () => {
    expect(detail).toContain("Complete skill body");
    expect(detail).not.toContain("font-semibold uppercase tracking-[0.14em]");
    expect(detail).toContain("<pre");
    expect(detail).toContain("Delete “{skill.name}”?");
    expect(detail).toContain("Delete “{skill.name}”");
  });

  test("uses active, organization-scoped config objects for CRUD", () => {
    expect(data).toContain('"/v1/config-objects?type=skill&status=active&limit=100"');
    expect(data).toContain('sourceMode: "cloud"');
    expect(data).toContain("/versions`");
    expect(data).toContain("/delete`");
    expect(data).toContain("organizationId");
  });
});
