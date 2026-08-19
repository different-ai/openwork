import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import {
  LINK_STEP,
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

test("the enterprise install guide is three steps ending in one copy-paste link", async ({ evidence }) => {
  const source = readFileSync(installScreenPath, "utf8");
  const downloadStep = stepBody(source, "install-guide-step-download");
  const openStep = stepBody(source, "install-guide-step-open");
  const linkStep = stepBody(source, "install-guide-step-link");

  expect(TOTAL_GUIDE_STEPS).toBe(3);
  expect(LINK_STEP).toBe(3);
  expect(parseGuideStep("2")).toBe(2);
  expect(parseGuideStep("3")).toBe(3);
  expect(parseGuideStep("4")).toBe(1);
  expect(parseGuideStep(null)).toBe(1);
  expect(parseGuideStep("nonsense")).toBe(1);

  // Step 1 downloads with every OS available; step 2 installs and opens in one
  // sentence; step 3 connects with the workspace address, keeping the OpenWork
  // link as the quiet backup.
  expect(downloadStep).toContain("DownloadPlatformGrid");
  expect(downloadStep).toContain("Already installed? Skip to step 3");
  expect(openStep).toContain('data-testid="install-app-ready"');
  expect(openStep).toContain("advanceGuide(LINK_STEP)");
  expect(openStep).toContain('{guidance.actions.join(" ")}');
  expect(openStep).toContain('<InstallVisual');
  expect(openStep).not.toContain("Come back to this page");
  expect(source).not.toContain('data-testid="install-connect-copy"');
  expect(source).not.toContain("Copy OpenWork link");
  expect(linkStep).toContain("In the app, enter your workspace address:");
  expect(linkStep).toContain('data-testid="install-workspace-address"');
  expect(linkStep).toContain("sign-in finishes in this browser and sends you back to the app.");

  // The old ceremony stays deleted: no fourth step, no running checklist, no
  // handoff mechanism note, no activation-link language.
  expect(source).not.toContain("install-guide-step-signin");
  expect(source).not.toContain("install-guide-step-confirm-running");
  expect(source).not.toContain("install-running-checklist");
  expect(source).not.toContain("install-handoff-note");
  expect(source).not.toMatch(/activation link/i);
  expect(source).toContain("Set up OpenWork Enterprise");
  expect(source).toContain('variant="flat"');
  expect(source).toContain('width="enterprise"');

  evidence.recordAssertionEvidence(
    "The guide is download, install/open, then connect",
    "parseGuideStep accepts steps 1-3, step 3 is only the workspace address and Continue guidance, step 2 is a picture plus one sentence, and the copy-link button, checklist, fourth step, and activation-link copy are gone.",
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

  evidence.recordAssertionEvidence(
    "The install guide uses the organization-picker shader, not the onboarding wash",
    "Every install OnboardingShell passes background=surface, the den shell renders the 2x2 #000000 dither over --dls-surface behind a WebGL guard, and the shared onboarding shell keeps its single #8FB7E8 layer.",
    true,
  );
});
