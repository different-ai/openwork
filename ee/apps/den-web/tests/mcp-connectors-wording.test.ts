import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const shellPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/org-dashboard-shell.tsx", import.meta.url),
);
const setupScreenPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/mcp-connections-screen.tsx", import.meta.url),
);
const memberScreenPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/your-connections-screen.tsx", import.meta.url),
);

describe("Den connector wording", () => {
  test("calls the admin setup surface Connectors", () => {
    const shell = readFileSync(shellPath, "utf8");
    const setupScreen = readFileSync(setupScreenPath, "utf8");

    expect(shell).toContain('label: "Connectors"');
    expect(setupScreen).toContain('title="Connectors"');
    expect(setupScreen).toContain("Add a connector");
    expect(setupScreen).toContain("Your connectors");
  });

  test("preserves the member-facing Your Connections name", () => {
    const shell = readFileSync(shellPath, "utf8");
    const memberScreen = readFileSync(memberScreenPath, "utf8");

    expect(shell).toContain('label: "Your Connections"');
    expect(memberScreen).toContain('title="Your Connections"');
  });
});
