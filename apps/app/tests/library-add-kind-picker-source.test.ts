import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pickerSource = readFileSync(
  join(import.meta.dir, "../src/react-app/domains/settings/pages/library-add-kind-picker.tsx"),
  "utf8",
);

describe("Add to your Library picker presentation", () => {
  test("renders all seven choices in one responsive selection surface", () => {
    expect(pickerSource.match(/role="radiogroup"/g)).toHaveLength(1);
    expect(pickerSource).toContain('"skill",\n  "command",\n  "agent",\n  "plugin",\n  "mcp",\n  "workspace-mcp",\n  "connection"');
    expect(pickerSource).not.toContain("function KindSection");
    expect(pickerSource).not.toContain('t("extensions.add_picker_make")');
    expect(pickerSource).not.toContain('t("extensions.add_picker_connect")');
  });

  test("keeps labeled connector cues compact and able to wrap", () => {
    expect(pickerSource).toContain('data-testid="connection-logo-cues"');
    expect(pickerSource).toContain("flex-wrap");
    expect(pickerSource).toContain('alt={`${cue.name} logo`}');
    expect(pickerSource).toContain('aria-label={`${cue.name} logo`}');
  });
});
