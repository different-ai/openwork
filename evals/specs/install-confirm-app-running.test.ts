import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import {
  CONFIRM_RUNNING_STEP,
  parseGuideStep,
  TOTAL_GUIDE_STEPS,
} from "../../ee/apps/den-web/app/(den)/_lib/install-guide";

const installScreenPath = fileURLToPath(
  new URL("../../ee/apps/den-web/app/(den)/_components/install-screen.tsx", import.meta.url),
);
const denShellPath = fileURLToPath(
  new URL("../../ee/apps/den-web/app/(den)/_components/onboarding-shell.tsx", import.meta.url),
);
const sharedShellPath = fileURLToPath(
  new URL("../../packages/ui/src/react/dithered-onboarding-shell.tsx", import.meta.url),
);

function stepBody(source: string, testId: string) {
  const start = source.indexOf(`testId="${testId}"`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("</InstallStep>", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

test("the enterprise install guide confirms the app is running in its own step", async ({ evidence }) => {
  const source = readFileSync(installScreenPath, "utf8");
  const confirmStep = stepBody(source, "install-guide-step-confirm-running");
  const openStep = stepBody(source, "install-guide-step-open");

  expect(TOTAL_GUIDE_STEPS).toBe(4);
  expect(CONFIRM_RUNNING_STEP).toBe(3);
  expect(parseGuideStep("2")).toBe(2);
  expect(parseGuideStep("3")).toBe(3);
  expect(parseGuideStep("4")).toBe(4);
  expect(parseGuideStep(null)).toBe(1);
  expect(parseGuideStep("nonsense")).toBe(1);

  // Activation is reachable only from the confirm-running step, never from installing.
  expect(confirmStep).toContain('data-testid="install-connect-open"');
  expect(confirmStep).toContain('data-testid="install-running-checklist"');
  expect(confirmStep).toContain("is installed and open on this computer.");
  expect(confirmStep).toContain("It is waiting on its activation screen.");
  expect(openStep).not.toContain('data-testid="install-connect-open"');
  expect(openStep).toContain('data-testid="install-app-ready"');
  expect(openStep).toContain("advanceGuide(CONFIRM_RUNNING_STEP)");

  // The install step stays light: no nested card, no heading repeating its own title.
  expect(openStep).not.toContain("Next, on your computer");
  expect(openStep).not.toContain("Open the file you just downloaded");
  expect(openStep).not.toContain("bg-white p-4 shadow-");
  expect(source).toContain("Step {guideStep} of {TOTAL_GUIDE_STEPS}");
  expect(source).toContain('index={4}');
  expect(source).toContain('testId="install-guide-step-signin"');

  evidence.fact(
    "Confirming the app runs is its own install step",
    "parseGuideStep accepts steps 1-4, the activate action lives only in step 3 next to the running checklist, and step 2 only installs/opens the app and hands off with install-app-ready.",
    true,
  );
});

test("the install guide renders on the organization-picker dither surface", async ({ evidence }) => {
  const installSource = readFileSync(installScreenPath, "utf8");
  const denShell = readFileSync(denShellPath, "utf8");
  const sharedShell = readFileSync(sharedShellPath, "utf8");
  const shellUsages = installSource.match(/<OnboardingShell\b[^>]*>/g) ?? [];

  expect(shellUsages.length).toBeGreaterThanOrEqual(4);
  for (const usage of shellUsages) {
    expect(usage).toContain('background="surface"');
  }

  // The surface variant mirrors the signed-in organization picker field.
  expect(denShell).toContain('colorFront="#000000"');
  expect(denShell).toContain('colorBack="#00000000"');
  expect(denShell).toContain('type="2x2"');
  expect(denShell).toContain("size={20.3}");
  expect(denShell).toContain("scale={1.19}");
  expect(denShell).toContain("bg-[var(--dls-surface)]");
  expect(denShell).toContain("const shaderSpeed = reducedMotion ? 0 : 0.01;");
  expect(denShell).toContain("useWebGlSupported");

  // The pre-sign-in onboarding wash is untouched for every other flow.
  expect(sharedShell).toContain('colorFront="#8FB7E8"');
  expect(sharedShell).toContain("bg-[#f8fbff]");
  expect(sharedShell).toContain("const shaderSpeed = reducedMotion ? 0 : 0.012;");
  expect((sharedShell.match(/<Dithering\b/g) ?? []).length).toBe(1);
  expect(denShell).toContain("<DitheredOnboardingShell");

  evidence.fact(
    "The install guide uses the organization-picker shader, not the onboarding wash",
    "Every install OnboardingShell passes background=surface, the den shell renders the 2x2 #000000 dither over --dls-surface behind a WebGL guard, and the shared onboarding shell keeps its single #8FB7E8 layer.",
    true,
  );
});
