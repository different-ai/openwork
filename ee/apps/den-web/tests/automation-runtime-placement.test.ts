import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function read(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("Automation runtime placement", () => {
  test("Web owns Cloud Automations while Desktop Automations stay on Desktop", () => {
    const screen = read("../app/(den)/dashboard/_components/automations-screen.tsx");

    expect(screen).toContain("Automations created here run headlessly in OpenWork Cloud")
    expect(screen).toContain("Desktop-created Automations stay on Desktop")
    expect(screen).toContain("New Automation")
  });

  test("the new Automation form promises Cloud wake-up without a placement picker", () => {
    const form = read("../app/(den)/dashboard/_components/cloud-automation-form.tsx");

    expect(form).toContain("New Cloud Automation")
    expect(form).toContain("Runs in OpenWork Cloud even when your desktop is offline")
    expect(form).toContain("A stopped Cloud container wakes automatically")
    expect(form).not.toContain(">Placement<")
    expect(form).not.toContain('aria-label="Automation placement"')
  });
});
