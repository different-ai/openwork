import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { linuxArm64RuntimeStaging } from "../worlds/linux-arm64-runtime-staging.ts";

// Release v0.18.70 failed every Linux ARM64 edition in afterPack: the x64
// runner staged linux-x64-gnu, and afterPack required linux-arm64-gnu. This
// proves the staging step `build:electron` runs, as that runner. It does not
// package, run afterPack or launch a Linux ARM64 app.
const test = spec.world(linuxArm64RuntimeStaging, {
  timeout: 300_000,
  resources: { surfaces: [], services: [] },
  needs: { commands: ["git"] },
});

const x64 = "@superradcompany/microsandbox-linux-x64-gnu";
const arm64 = "@superradcompany/microsandbox-linux-arm64-gnu";

test("a Linux x64 release runner stages the packaged CPU's sandbox runtime for each target", async ({ world, step, evidence }) => {
  await step("the x64 Linux edition (TARGET=x86_64-unknown-linux-gnu) ships the x64 runtime", async () => {
    const result = await world.stage("x86_64-unknown-linux-gnu");
    evidence.recordAssertionEvidence("x64 target stages only the x64 runtime", JSON.stringify(result), result.natives.length === 1 && result.natives[0] === x64);
    expect(result.natives).toEqual([x64]);
  });

  await step("the ARM64 Linux edition (TARGET=aarch64-unknown-linux-gnu) ships the ARM64 runtime, not the runner's", async () => {
    const result = await world.stage("aarch64-unknown-linux-gnu");
    evidence.recordAssertionEvidence("ARM64 target stages only the ARM64 runtime", JSON.stringify(result), result.natives.length === 1 && result.natives[0] === arm64);
    expect(result.natives).toEqual([arm64]);
    expect(result.natives).not.toContain(x64);
  });
});
