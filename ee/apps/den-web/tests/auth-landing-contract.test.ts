import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const authPanelPath = fileURLToPath(
  new URL("../app/(den)/_components/auth-panel.tsx", import.meta.url),
);

describe("Den auth landing contract", () => {
  // Signup layout and responsive visuals are exercised by signup-workspace-intent.e2e.test.ts.
  test("starts the email-first panel with the approved heading", () => {
    const source = readFileSync(authPanelPath, "utf8");

    expect(source).toContain('title: "Start using OpenWork"');
    expect(source).toContain("Enter your email and we'll send you to the right sign-in step.");
    expect(source).not.toContain("Continue to OpenWork.");
  });

  test("signed-in desktop handoff shows account email and a pasteable link by default", () => {
    const source = readFileSync(authPanelPath, "utf8");

    expect(source).toContain('data-testid="desktop-signed-in-handoff"');
    expect(source).toContain("Logged in as");
    expect(source).toContain("showCopyLinkByDefault");
    expect(source).toContain('data-testid="desktop-handoff-copy-link"');
    expect(source).toContain("desktopAuthRequested && user && !authError");
    expect(source).not.toContain("showAuthFeedback && authInfo && !authError");
  });
});
