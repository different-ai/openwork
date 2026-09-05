import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appRoot = join(import.meta.dir, "..", "app", "(den)");

function readComponent(...segments: string[]) {
  return readFileSync(join(appRoot, ...segments), "utf8");
}

const screen = readComponent("dashboard", "_components", "llm-providers-screen.tsx");
const shell = readComponent("dashboard", "_components", "org-dashboard-shell.tsx");
const navigation = readComponent("dashboard", "_lib", "dashboard-navigation.ts");

describe("Bring your Own Keys page", () => {
  test("sidebar and page title use the product name", () => {
    expect(navigation).toContain('label: "Bring your Own Keys"');
    expect(shell).toContain('return "Bring your Own Keys";');
    expect(shell).not.toContain('"LLM Providers"');
    expect(screen).toContain('title="Bring your Own Keys"');
  });

  test("access controls keep the ids the invitee flow drives", () => {
    for (const testId of [
      "models-access-card",
      "models-access-open",
      "models-access-managed",
      "models-access-admin-exception",
      "models-access-zen",
      "models-access-save",
      "models-access-outcome",
    ]) {
      expect(screen).toContain(testId);
    }
  });

  test("editor explains Azure Foundry project URLs for resource names", () => {
    const editor = readComponent("dashboard", "_components", "llm-provider-editor-screen.tsx");
    expect(editor).toContain("Azure Foundry may show a project URL");
    expect(editor).toContain("yourFoundryResourceName");
    expect(editor).toContain("Paste the resource name or Azure Foundry project URL");
  });

  test("screen is built from shared primitives instead of local markup", () => {
    for (const primitive of ["DenOptionCard", "DenSectionHeader", "DenListRow", "DenBrandMark", "DenChip", "DenNotice"]) {
      expect(screen).toContain(primitive);
    }
    expect(screen).not.toContain("OpenWork Model Keys");
    expect(screen).not.toContain("getProviderEnvNames");
    expect(screen).not.toContain("<table");
    expect(screen).not.toContain("<input");
    expect(screen).not.toContain("hover:-translate-y-0.5");
  });

  test("option card renders a native input so keyboard and e2e flows keep working", () => {
    const optionCard = readComponent("_components", "ui", "option-card.tsx");
    expect(optionCard).toContain("<input");
    expect(optionCard).toContain("data-testid={testId}");
  });

  test("brand mark reuses the shared icon ladder and ends on a monogram", () => {
    const brandMark = readComponent("_components", "ui", "brand-mark.tsx");
    const integrationIcon = readComponent("dashboard", "_components", "integration-icon.tsx");
    expect(brandMark).toContain("brandIconCandidates");
    expect(integrationIcon).toContain("brandIconCandidates");
    expect(integrationIcon).not.toContain("cdn.simpleicons.org");
    expect(brandMark).toContain("monogram");
  });
});
