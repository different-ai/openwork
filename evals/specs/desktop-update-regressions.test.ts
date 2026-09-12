import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { desktopUpdateRegressionsWorld } from "../worlds/desktop-update-regressions.ts";

const test = spec.world(desktopUpdateRegressionsWorld, {
  resources: { surfaces: [], services: [] },
  needs: { commands: ["git", "pnpm", "node", "bun"], placement: "local" },
  timeout: 90_000,
});

for (const suite of ["main", "renderer"] satisfies ("main" | "renderer")[]) {
  test(`app-less ${suite} updater regressions execute against the recorded checkout`, async ({ world, evidence }) => {
    const result = world.run(suite);
    const passed = result.status === 0 && result.failed === 0 && result.passed === (suite === "main" ? 33 : 62) &&
      result.passed === result.total && result.skipped === 0 && result.cancelled === 0 && result.todo === 0 &&
      JSON.stringify(result.before) === JSON.stringify(result.after);
    evidence.recordAssertionEvidence(
      `App-less ${suite} regression adapter; not Electron UI or native installer proof`,
      `${result.command}\nHEAD and subject hashes: ${JSON.stringify(result.before)}\nSubjects: ${world.subjects.join(", ")}\nWorking-tree changes require a final-head rerun.\nExit: ${result.status}\n${result.output}`,
      passed,
    );
    expect(result.error, result.output).toBeUndefined();
    expect(result.signal, result.output).toBeNull();
    expect(result.status, result.output).toBe(0);
    expect(result.before.head).toMatch(/^[a-f0-9]{40}$/);
    expect(result.after).toEqual(result.before);
    expect(result.passed, result.output).toBe(suite === "main" ? 33 : 62);
    expect(result.total, result.output).toBe(result.passed);
    expect(result.failed, result.output).toBe(0);
    expect(result.skipped, result.output).toBe(0);
    expect(result.cancelled, result.output).toBe(0);
    expect(result.todo, result.output).toBe(0);
    expect(result.output).not.toMatch(/\b[1-9]\d* (?:skip|todo|filtered out)\b/);
    if (suite === "main") {
      expect(result.output).toContain("metadata-only updater checks");
      expect(result.output).toContain("updater artifact metadata size");
      expect(result.output).toContain("downloaded update lifecycle");
      expect(result.output).toContain("macOS native staging");
      expect(result.output).toContain("Alpha metadata check 2962 to 2966 leaves Alpha 2962 installable");
    } else {
      expect(result.output).toContain("ready Check now calls preserveStaged IPC and never downloads automatically");
      expect(result.output).toContain("focus, online, visibility and automatic timer never check while ready");
      expect(result.output).toContain("explicit Download B clears staged metadata and becomes ready B only on success");
      expect(result.output).toContain("refuses to install a version revoked between download and install");
      expect(result.output).toContain("selects the highest approved published release above the installed version");
      expect(result.output).toContain("never selects an older approved release");
    }
  });
}
