import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const sidebar = readFileSync(
  fileURLToPath(new URL("../src/react-app/domains/session/sidebar/app-sidebar.tsx", import.meta.url)),
  "utf8",
);

describe("dashboard sidebar destination", () => {
  test("appears immediately after session search and before the other destinations", () => {
    const search = sidebar.indexOf("props.onOpenSessionSearch ?");
    const dashboard = sidebar.indexOf("props.onOpenDashboard ?", search);
    const automations = sidebar.indexOf("props.onOpenAutomations ?", search);

    expect(search).toBeGreaterThan(-1);
    expect(dashboard).toBeGreaterThan(search);
    expect(dashboard).toBeLessThan(automations);
  });
});
