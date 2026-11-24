import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { windowsArm64RuntimeStaging } from "../worlds/windows-arm64-runtime-staging.ts";

// Release v0.18.70 failed every Windows ARM64 edition after packaging: the
// x64 runner staged its own CPU's microsandbox runtime into the ARM64 app.
// This proves the staging step `build:electron` runs, as that runner. It does
// not package, sign or launch a Windows ARM64 app.
const test = spec.world(windowsArm64RuntimeStaging, {
  timeout: 300_000,
  resources: { surfaces: [], services: [] },
  needs: { commands: ["git"] },
});

const x64 = "@superradcompany/microsandbox-win32-x64-msvc";
const arm64 = "@superradcompany/microsandbox-win32-arm64-msvc";

test("a Windows x64 release runner stages the packaged CPU's sandbox runtime for each target", async ({ world, step, evidence }) => {
  await step("the x64 Windows edition (TARGET=x86_64-pc-windows-msvc) ships the x64 runtime", async () => {
    const result = await world.stage("x86_64-pc-windows-msvc");
    evidence.recordAssertionEvidence("x64 target stages only the x64 runtime", JSON.stringify(result), result.natives.length === 1 && result.natives[0] === x64);
    expect(result.natives).toEqual([x64]);
  });

  await step("the ARM64 Windows edition (TARGET=aarch64-pc-windows-msvc) ships the ARM64 runtime, not the runner's", async () => {
    const result = await world.stage("aarch64-pc-windows-msvc");
    evidence.recordAssertionEvidence("ARM64 target stages only the ARM64 runtime", JSON.stringify(result), result.natives.length === 1 && result.natives[0] === arm64);
    expect(result.natives).toEqual([arm64]);
    expect(result.natives).not.toContain(x64);
  });
});
