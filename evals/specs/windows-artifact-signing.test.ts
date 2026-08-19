import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { expect, onTestFinished } from "vitest";
import { test } from "@openwork/testkit";

const repoRoot = resolve(import.meta.dirname, "../..");
const workflowPath = join(repoRoot, ".github", "workflows", "release-macos-aarch64.yml");
const refreshScriptPath = join(repoRoot, "scripts", "release", "refresh-signed-windows-artifacts.mjs");

const installers = [
  ["openwork-win-x64-1.2.3.exe", "latest.yml"],
  ["openwork-win-arm64-1.2.3.exe", "latest.yml"],
  ["openwork-cloud-win-x64-1.2.3.exe", "cloud.yml"],
  ["openwork-cloud-win-arm64-1.2.3.exe", "cloud.yml"],
  ["openwork-enterprise-win-x64-1.2.3.exe", "enterprise.yml"],
  ["openwork-enterprise-win-arm64-1.2.3.exe", "enterprise.yml"],
] as const;

const windowsMatrixArtifacts = [
  "electron-windows-x64",
  "electron-windows-arm64",
  "electron-cloud-windows-x64",
  "electron-cloud-windows-arm64",
  "electron-enterprise-windows-x64",
  "electron-enterprise-windows-arm64",
] as const;

test("the Windows matrix signs every installer in place before publication", async ({ evidence }) => {
  const workflow = await readFile(workflowPath, "utf8");
  const sharedBuildSteps = workflow.match(/steps: &electron-build-steps[\s\S]*?\n  publish-electron-windows:/)?.[0] ?? "";
  const windowsJob = workflow.match(/publish-electron-windows:[\s\S]*?\n    steps: \*electron-build-steps/)?.[0] ?? "";
  const windowsJobHeader = windowsJob.match(/[\s\S]*?\n    strategy:/)?.[0] ?? "";

  expect(workflow.match(/uses: azure\/artifact-signing-action@[0-9a-f]{40} # v2/g)).toHaveLength(1);
  expect(windowsJob.match(/artifact: electron-(?:cloud-|enterprise-)?windows-(?:x64|arm64)/g)).toHaveLength(6);
  expect(windowsJob).toContain("runs-on: ${{ matrix.platform }}");
  expect(windowsJob).toContain("environment: windows-signing");
  expect(windowsJob).toContain("id-token: write");
  expect(sharedBuildSteps).toContain("if: matrix.os_type == 'windows' && env.SIGN_WINDOWS == 'true'");
  expect(sharedBuildSteps).toContain("files-folder-recurse: false");
  expect(sharedBuildSteps).toContain("Expected one signed Windows installer");
  expect(sharedBuildSteps).toContain("refresh-signed-windows-artifacts.mjs apps/desktop/dist-electron 1");
  expect(sharedBuildSteps.indexOf("Refresh signed installer blockmap and manifest")).toBeLessThan(
    sharedBuildSteps.indexOf("Upload Electron release assets"),
  );
  expect(workflow).toMatch(/sign_windows:\n(?: {8}.+\n)* {8}default: true/);
  expect(workflow).toContain("needs.publish-electron-windows.result == 'success'");
  expect(workflow).toContain("vars.AZURE_CLIENT_ID || secrets.AZURE_CLIENT_ID");
  expect(windowsJobHeader).not.toContain("AZURE_CLIENT_ID");

  evidence.recordAssertionEvidence(
    "Windows signing is the default and every matrix build signs before upload",
    "Manual releases default sign_windows to true. Six Windows matrix targets use the protected windows-signing environment and OIDC permission. Shared build steps sign exactly one installer, verify its signature, refresh its signed blockmap and manifest, and only then upload release assets. Azure values remain scoped to signing steps rather than the job-wide environment.",
    true,
  );
});

test("public, cloud, and enterprise Windows targets avoid an unsigned artifact transfer", async ({ evidence }) => {
  const workflow = await readFile(workflowPath, "utf8");
  const windowsJob = workflow.match(/publish-electron-windows:[\s\S]*?\n    steps: \*electron-build-steps/)?.[0] ?? "";

  for (const artifactName of windowsMatrixArtifacts) {
    expect(windowsJob).toContain(`artifact: ${artifactName}`);
  }
  expect(workflow).not.toContain("unsigned-electron");
  expect(workflow).not.toContain("sign-and-publish-windows:");

  evidence.recordAssertionEvidence(
    "All Windows artifact families are signed without a serial artifact hop",
    `The Windows matrix contains ${windowsMatrixArtifacts.join(", ")}. None uploads an unsigned-electron intermediate or waits for a sign-and-publish-windows aggregation job.`,
    true,
  );
});

test("signed Windows metadata is regenerated for every distribution and architecture", async ({ evidence }) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "openwork-windows-signing-"));
  onTestFinished(() => rm(fixtureRoot, { recursive: true, force: true }));

  for (const [index, [installerName, manifestName]] of installers.entries()) {
    const artifactDir = join(fixtureRoot, `artifact-${index}`);
    await mkdir(artifactDir, { recursive: true });
    const installerPath = join(artifactDir, installerName);
    await writeFile(installerPath, `signed-installer-${installerName}`);
    await writeFile(
      join(artifactDir, manifestName),
      `version: 1.2.3\nfiles:\n  - url: ${installerName}\n    sha512: unsigned\n    size: 1\npath: ${installerName}\nsha512: unsigned\n`,
    );

    const result = spawnSync(process.execPath, [refreshScriptPath, artifactDir, "1"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);

    const expectedSha512 = createHash("sha512").update(await readFile(installerPath)).digest("base64");
    const manifest = await readFile(join(artifactDir, manifestName), "utf8");
    expect(manifest).toContain(expectedSha512);
    expect((await stat(`${installerPath}.blockmap`)).size).toBeGreaterThan(0);
  }

  evidence.recordAssertionEvidence(
    "Each signed matrix installer receives byte-accurate updater metadata",
    `Six independent helper invocations regenerated blockmaps and SHA-512 manifest entries for ${installers.map(([name]) => basename(name)).join(", ")}.`,
    true,
  );
});
