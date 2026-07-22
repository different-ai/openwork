import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const authScreenPath = fileURLToPath(
  new URL("../app/(den)/_components/auth-screen.tsx", import.meta.url),
);
const authPanelPath = fileURLToPath(
  new URL("../app/(den)/_components/auth-panel.tsx", import.meta.url),
);

describe("Den auth landing contract", () => {
  test("keeps the simple bounded split layout and mobile logo", () => {
    const source = readFileSync(authScreenPath, "utf8");

    expect(source).toContain("max-w-[600px]");
    expect(source).toContain("lg:grid-cols-[1fr_5fr]");
    expect(source).not.toContain("lg:grid-cols-[2fr_1fr]");
    expect(source).toContain('data-testid="auth-landing-visual"');
    expect(source).toContain('data-testid="auth-landing-form"');
    expect(source).toContain('data-testid="auth-landing-mobile-brand"');
    expect(source).toContain("lg:hidden");
    expect(source).toContain('src="/openwork-mark.svg"');
  });

  test("removes the old marketing panel content from the shader side", () => {
    const source = readFileSync(authScreenPath, "utf8");

    expect(source).not.toContain("openwork-logo-transparent.svg");
    expect(source).not.toContain("OpenWork Cloud");
    expect(source).not.toContain("One setup, every seat.");
    expect(source).not.toContain("Configure once. Your whole team gets the same tools, agents, and providers.");
    expect(source).not.toContain("Shared config");
    expect(source).not.toContain("Cloud agents");
    expect(source).not.toContain("Your models");
  });

  test("keeps the visual panel as Dithering only", () => {
    const source = readFileSync(authScreenPath, "utf8");

    expect(source).toContain('import { Dithering } from "@paper-design/shaders-react"');
    expect(source).not.toContain("PaperMeshGradient");
    expect(source).toContain('style={{ backgroundColor: "#142033", width: "100%", height: "100%" }}');
    expect(source).toContain('data-testid="auth-landing-visual"');
  });

  test("starts the email-first panel with the approved heading", () => {
    const source = readFileSync(authPanelPath, "utf8");

    expect(source).toContain('title: "Start using OpenWork"');
    expect(source).toContain("Enter your email and we'll send you to the right sign-in step.");
    expect(source).not.toContain("Continue to OpenWork.");
  });
});
