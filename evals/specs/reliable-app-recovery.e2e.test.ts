import { rm } from "node:fs/promises";
import { expect } from "vitest";
import { clickButton, evalIn, visibleText } from "@openwork/behaviors";
import {
  checkedExec,
  daytonaSandbox,
  defaultDaytonaExec,
  deleteSandboxes,
  desktop,
  localHost,
  provisionDesktopSandbox,
} from "@openwork/hosts";
import { eventually, needs, test } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const daytonaEnabled = process.env.OPENWORK_EVAL_DAYTONA === "1";
const title = e2eTestsEnabled
  ? "a fatal desktop bootstrap failure offers one-click verified recovery without losing the profile"
  : "reliable app recovery skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";
const profileMarker = "reliable-recovery-profile-marker";
const fatalFailure = "EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE: dlopen(/private/tmp/runtime.node): invalid code signature";
const verifiedArtifact = "https://releases.openwork.test/v1.8.2/OpenWork-darwin-arm64.dmg";

test.skipIf(!e2eTestsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  const profileDir = `/tmp/openwork-reliable-recovery-${process.pid}-${Date.now()}`;
  const provisioned = daytonaEnabled
    ? await provisionDesktopSandbox({
        ref: process.env.OPENWORK_EVAL_REF?.trim() || process.env.GITHUB_SHA?.trim() || "dev",
        name: "reliable-app-recovery",
        reuse: process.env.OPENWORK_EVAL_DAYTONA_SANDBOX?.trim(),
        log: (line) => console.error(`[openwork/testkit] ${line}`),
      })
    : null;
  const host = provisioned ? daytonaSandbox(provisioned.sandbox) : localHost();

  try {
    {
      await using seededApp = await desktop({ name: "recovery-profile-seed", host, profileDir });
      const seededWorkspaceNames = await evalIn(
        seededApp,
        `window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceCreate", {
          folderPath: ${JSON.stringify(`${profileDir}/continuity-workspace`)},
          name: ${JSON.stringify(profileMarker)}
        }).then((state) => state.workspaces.map((workspace) => workspace.displayName))`,
        { awaitPromise: true },
      );
      expect(seededWorkspaceNames).toContain(profileMarker);
    }

    await using recoveryApp = await desktop({
      name: "fatal-bootstrap-recovery",
      host,
      profileDir,
      timeoutMs: 30_000,
      env: {
        OPENWORK_EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE: fatalFailure,
        OPENWORK_EVAL_RECOVERY_CANDIDATES: JSON.stringify([
          { version: "1.8.2", verified: true, artifactUrl: verifiedArtifact },
          { version: "1.8.1", verified: false, artifactUrl: "https://tampered.invalid/OpenWork.dmg" },
        ]),
      },
    });

    const recoveryObserverAvailable = await evalIn(
      recoveryApp,
      `typeof window.__openworkRecoveryControl?.snapshot === "function"
        && typeof window.__openworkRecoveryControl?.select === "function"`,
    );
    expect(
      recoveryObserverAvailable,
      "testkit cannot yet inject or observe the approved fatal-bootstrap recovery journey",
    ).toBe(true);

    const text = await visibleText(recoveryApp);
    expect(text).toMatch(/OpenWork (couldn't|could not) start/i);
    expect(text).toContain("Restore previous version");
    expect(text).not.toContain(fatalFailure);
    expect(text).not.toMatch(/GitHub|open an issue|download.*manually/i);
    const recoveredWorkspaceNames = await evalIn(
      recoveryApp,
      `window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceBootstrap")
        .then((state) => state.workspaces.map((workspace) => workspace.displayName))`,
      { awaitPromise: true },
    );
    expect(recoveredWorkspaceNames).toContain(profileMarker);

    const offeredVersions = await eventually(
      () => evalIn(
        recoveryApp,
        `window.__openworkRecoveryControl.snapshot().then((snapshot) => snapshot.candidates.map((candidate) => candidate.version))`,
        { awaitPromise: true },
      ),
      { within: 5_000, label: "verified recovery candidates", until: (versions) => Array.isArray(versions) && versions.length === 1 },
    );
    expect(offeredVersions).toEqual(["1.8.2"]);

    await evalIn(recoveryApp, `window.__openworkRecoveryControl.select("1.8.1")`, { awaitPromise: true });
    expect(await evalIn(recoveryApp, `window.__openworkRecoveryControl.snapshot().then((snapshot) => snapshot.installRequests)`, { awaitPromise: true })).toEqual([]);
    expect(await evalIn(recoveryApp, `window.__openworkRecoveryControl.snapshot().then((snapshot) => snapshot.quitRequested)`, { awaitPromise: true })).toBe(false);

    await clickButton(recoveryApp, "Restore previous version", { timeoutMs: 5_000 });
    const installRequests = await eventually(
      () => evalIn(recoveryApp, `window.__openworkRecoveryControl.snapshot().then((snapshot) => snapshot.installRequests)`, { awaitPromise: true }),
      {
        within: 5_000,
        label: "verified previous recovery install intent",
        until: (requests) => Array.isArray(requests) && requests.length === 1,
      },
    );
    expect(installRequests).toEqual([{ version: "1.8.2", artifactUrl: verifiedArtifact }]);
    expect(await evalIn(recoveryApp, `window.__openworkRecoveryControl.snapshot().then((snapshot) => snapshot.quitRequested)`, { awaitPromise: true })).toBe(false);
    evidence.recordAssertionEvidence(
      "Fatal bootstrap recovery selected one verified previous release without losing the profile",
      "The recovery observer recorded exactly one verified install request, no invalid request, and no quit intent.",
      true,
    );
  } finally {
    try {
      await host[Symbol.asyncDispose]();
    } finally {
      if (provisioned) {
        try {
          await checkedExec(
            defaultDaytonaExec,
            ["exec", provisioned.sandbox, "--", "rm", "-rf", profileDir],
            `remove caller-owned recovery profile ${profileDir}`,
            { timeoutMs: 30_000 },
          );
        } finally {
          if (provisioned.created) await deleteSandboxes([provisioned.sandbox]);
        }
      } else {
        await rm(profileDir, { recursive: true, force: true });
      }
    }
  }
});
