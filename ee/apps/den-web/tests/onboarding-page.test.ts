import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appRoot = join(import.meta.dir, "..", "app", "(den)");

function read(...segments: string[]) {
  return readFileSync(join(appRoot, ...segments), "utf8");
}

const screen = read("dashboard", "_components", "marketplace-onboarding-screen.tsx");
const page = read("dashboard", "(admin)", "onboarding", "page.tsx");

describe("Marketplace onboarding page", () => {
  test("finishes setup without downloads or an installation checklist", () => {
    expect(screen).not.toContain("DownloadOpenWorkCard");
    expect(screen).not.toContain("send-download-link");
    expect(screen).not.toContain("app-installed");
    expect(screen).toContain("DenBadge");
    expect(page).not.toContain("getPublicInstallers");
    expect(screen).toContain("Complete and open the app");
    expect(screen).toContain("completeSetup(orgId)");
  });

  test("offers OpenWork Models and Bring your Own Keys as the model path", () => {
    expect(screen).toContain("onboarding-choice-openwork-models");
    expect(screen).toContain("onboarding-choice-byok");
    expect(screen).toContain("Explore models");
    expect(screen).toContain("Bring your Own Keys");
    expect(screen).toContain("/openwork-mark.svg");
  });

  test("checks model status without enabling models", () => {
    expect(screen).toContain("/v1/inference");
    expect(screen).toContain('headers: { "x-openwork-org-id": orgId }');
    expect(screen).not.toContain('method: "POST"');
    expect(screen).toContain("Signing in does not enable models.");
    expect(screen).toContain("No model selection is required");
  });

  test("retains the web Models route and focuses Models before desktop completion", () => {
    const tools = read("dashboard", "_components", "onboarding-tools-screen.tsx");
    expect(tools).toContain('intent === "models" && !desktopAuthRequested');
    expect(tools).toContain("router.push(getInferenceRoute(orgSlug))");
    expect(screen).toContain("modelsHeading.current?.focus()");
    expect(screen).not.toContain("removeItem(PENDING_AUTH_INTENT_STORAGE_KEY)");
  });
});
