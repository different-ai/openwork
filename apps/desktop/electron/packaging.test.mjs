import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { parse } from "yaml";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

describe("desktop packaging dependencies", () => {
  it("installs both CPU variants of native packages for Electron release builds", () => {
    const workflow = parse(
      readFileSync(resolve(repoRoot, ".github/workflows/release-macos-aarch64.yml"), "utf8"),
    );
    const steps = workflow.jobs["publish-electron"].steps;
    const installStep = steps.find((step) => step.name === "Install dependencies (macOS dual arch)");

    assert.ok(installStep);
    assert.equal(installStep.if, "matrix.os_type == 'macos'");
    assert.match(installStep.run, /supportedArchitectures\.cpu\[\]=x64/);
    assert.match(installStep.run, /supportedArchitectures\.cpu\[\]=arm64/);
    assert.match(installStep.run, /pnpm install --frozen-lockfile/);
  });
});
