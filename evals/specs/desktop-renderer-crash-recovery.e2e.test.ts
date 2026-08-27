import { expect } from "vitest";
import { evalIn, waitFor, waitForText } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

test("an unexpected renderer exit recovers once without stranding a blank window", async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  await using app = await desktop({ name: "desktop-renderer-crash-recovery" });

  await waitForText(app, "Welcome to OpenWork", { timeoutMs: 30_000 });
  const rendererMarker = `renderer-before-crash-${Date.now()}`;
  expect(await evalIn(app, `window.__openworkCrashMarker = ${JSON.stringify(rendererMarker)}`)).toBe(rendererMarker);
  await app.client.send("Page.crash", {}, { timeoutMs: 5_000 }).catch(() => undefined);

  await waitFor(app, "document.body.innerText.trim().length > 40", {
    timeoutMs: 45_000,
    label: "meaningful OpenWork content after renderer recovery",
  });
  await waitForText(app, "Welcome to OpenWork", { timeoutMs: 30_000 });
  const recoveredRoute = await evalIn(app, "window.__openworkControl.snapshot().route", {
    timeoutMs: 15_000,
  });
  const recoveredMarker = await evalIn(app, "window.__openworkCrashMarker ?? null");
  const cdpHealth = await fetch(`${app.handle.cdpUrl.replace(/\/$/, "")}/json/version`, {
    signal: AbortSignal.timeout(5_000),
  });

  expect(app.client.targetId).toBeTruthy();
  expect(recoveredMarker).toBeNull();
  expect(cdpHealth.ok).toBe(true);
  expect(recoveredRoute).toContain("/welcome");
  evidence.recordAssertionEvidence(
    "A crashed renderer is replaced by a usable OpenWork page",
    `rendererMarkerReset=${String(recoveredMarker === null)}; mainProcessCdpHealthy=${String(cdpHealth.ok)}; route=${String(recoveredRoute)}`,
    Boolean(recoveredMarker === null && cdpHealth.ok && String(recoveredRoute).includes("/welcome")),
  );
});
