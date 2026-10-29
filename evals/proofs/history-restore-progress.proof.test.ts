import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { historyRestoreProgress } from "../worlds/history-restore-progress.ts";

const test = spec.world(historyRestoreProgress, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["desktop"], services: [], nativeReason: "Capture the actual isolated Electron migration dialog while its real worker restores native-converted synthetic history." },
});

test("the migration dialog reports real restoring progress instead of an indeterminate chat count", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await user.reload();
  await step("open the actual running migration through its progress control", async () => {
    await user.see({ text: "Migrating chats to OpenCode v2" }, { timeoutMs: 60_000 });
    // Dismiss transient first-launch surfaces using real keyboard controls, then
    // activate the migration banner's button without coordinate/resize races.
    for (let attempt = 0; attempt < 4; attempt++) {
      const dialogs = (await probe.dom('[data-testid="engine-migration-progress"]')).elements.length;
      if (!dialogs && !(await world.modelSearch())) break;
      await user.press("Escape");
    }
    let opened = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const control = await world.activeControl();
      if (control.button && control.label === "Show progress") {
        await user.press("Enter");
        opened = true;
        break;
      }
      await user.press("Tab");
    }
    expect(opened).toBe(true);
    await user.see({ role: "button", label: "Continue using OpenWork" });
  });
  await step("restoration is real, visible and bounded by its actual message total", async () => {
    const initial = await world.counters();
    await world.advance();
    const counters = await probe.eventually(() => world.counters(), {
      within: 30_000, label: "committed restoration work exists", until: value => value.done > 0 && value.done < value.total,
    });
    expect(counters.done).toBeGreaterThan(initial.done);
    const status = await world.status();
    expect(status?.state).toBe("running");
    const label = await probe.eventually(async () => (await probe.dom('[data-testid="engine-migration-count"]')).elements[0]?.text ?? "", {
      within: 30_000, label: "migration phase label", until: value => world.legacy ? value.includes("chats to copy") : value.includes("Restoring messages:"),
    });
    if (world.legacy) {
      expect(status?.phase).toBe("starting");
      expect(label).not.toContain("Restoring messages:");
    } else {
      expect(status?.phase).toBe("restoring");
      expect(status?.restored).toBeGreaterThan(0);
      expect(status?.restoreTotal).toBe(counters.total);
      expect(label).toContain(new Intl.NumberFormat().format(counters.total));
    }
    const healthy = await probe.eventually(() => world.layoutHealthy(), {
      within: 5_000, label: "one settled, unclipped migration dialog", until: value => value.healthy,
    });
    expect(healthy.healthy).toBe(true);
    const displayed = /Restoring messages:\s*([\d,]+)/.exec(label);
    const displayedDone = displayed ? Number(displayed[1].replaceAll(",", "")) : 0;
    const phaseMatches = world.legacy
      ? status?.phase === "starting" && label.includes("chats to copy") && !label.includes("Restoring messages:")
      : status?.phase === "restoring" && status.restored > 0 && status.restoreTotal === counters.total
        && displayedDone > 0 && displayedDone <= counters.total && label.includes(new Intl.NumberFormat().format(counters.total));
    const observedAgreement = status?.state === "running" && counters.done > initial.done
      && counters.done < counters.total && healthy.healthy && phaseMatches;
    // Persist the observed predicate (including false), not an assumed verdict.
    // expect remains the test oracle; the record makes its inputs inspectable.
    evidence.recordAssertionEvidence("Restoring phase and visible progress match actual committed work",
      `phase=${String(status?.phase)}; committed=${initial.done}->${counters.done}/${counters.total}; visible=${label}; layoutHealthy=${healthy.healthy}`,
      observedAgreement);
    expect(observedAgreement).toBe(true);
    const shot = await user.screenshot();
    await world.saveFrame(shot.png);
  });
});
