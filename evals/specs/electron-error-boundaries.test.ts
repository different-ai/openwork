import { expect } from "vitest";
import { test } from "@openwork/testkit";
import {
  loadBrowserTabUrl,
  openExternalUrl,
  routeOpenworkDeepLink,
} from "../../apps/desktop/electron/open-external.mjs";
import {
  createGpuAbnormalExitSuppressor,
  isNoisyGpuAbnormalExitEvent,
} from "../../apps/desktop/electron/sentry.mjs";

test("Electron contains expected platform errors without hiding actionable failures", async ({ evidence }) => {
  const openedUrls: string[] = [];
  const unsupportedResults = await Promise.all([
    "file:///tmp/report.html",
    "javascript:alert(1)",
    "openwork://connect?token=private",
  ].map((url) => openExternalUrl(url, {
    env: {},
    openExternal: async (target) => {
      openedUrls.push(target);
    },
  })));

  expect(unsupportedResults.every((result) => result.ok === false)).toBe(true);
  expect(openedUrls).toEqual([]);
  evidence.fact(
    "Unsupported external protocols never reach the operating system",
    "file:, javascript:, and openwork: were all rejected before the injected shell.openExternal witness could observe a URL.",
    unsupportedResults.every((result) => result.ok === false) && openedUrls.length === 0,
  );

  const routedDeepLinks: string[][] = [];
  const onDeepLink = (urls: string[]) => routedDeepLinks.push(urls);
  const productionRouted = routeOpenworkDeepLink("openwork://connect?token=prod", onDeepLink);
  const developmentRouted = routeOpenworkDeepLink("openwork-dev://connect?token=dev", onDeepLink);
  const webRouted = routeOpenworkDeepLink("https://example.com", onDeepLink);

  expect(productionRouted).toBe(true);
  expect(developmentRouted).toBe(true);
  expect(webRouted).toBe(false);
  expect(routedDeepLinks).toEqual([
    ["openwork://connect?token=prod"],
    ["openwork-dev://connect?token=dev"],
  ]);
  evidence.fact(
    "OpenWork deep links route only to the desktop callback",
    "Both production and development OpenWork protocols reached the callback unchanged, while an https URL did not.",
    productionRouted && developmentRouted && !webRouted && routedDeepLinks.length === 2,
  );

  const aborted = Object.assign(new Error("navigation aborted"), { code: "ERR_ABORTED" });
  const reset = Object.assign(new Error("connection reset"), { code: "ERR_CONNECTION_RESET" });
  const contained = await loadBrowserTabUrl("https://example.com/aborted", async () => {
    throw aborted;
  });

  expect(contained).toBeUndefined();
  await expect(loadBrowserTabUrl("https://example.com/reset", async () => {
    throw reset;
  })).rejects.toBe(reset);
  evidence.fact(
    "Only cancelled navigation is contained",
    "A coded ERR_ABORTED resolved as an expected cancellation, while ERR_CONNECTION_RESET rejected with the original failure.",
    contained === undefined,
  );

  let now = 1_000;
  const shouldSuppress = createGpuAbnormalExitSuppressor({ now: () => now, windowMs: 60_000 });
  const recoverableWarning = {
    level: "warning",
    message: "'GPU' process exited with 'abnormal-exit'",
    tags: { "event.process": "GPU" },
  };
  const severeFailure = {
    level: "error",
    message: "'GPU' process exited with 'abnormal-exit'",
    tags: { "event.process": "GPU" },
  };
  const firstSuppressed = shouldSuppress(recoverableWarning);
  now += 1_000;
  const repeatedSuppressed = shouldSuppress(recoverableWarning);
  const severeSuppressed = shouldSuppress(severeFailure);

  expect(firstSuppressed).toBe(true);
  expect(repeatedSuppressed).toBe(false);
  expect(isNoisyGpuAbnormalExitEvent(severeFailure)).toBe(false);
  expect(severeSuppressed).toBe(false);
  evidence.fact(
    "GPU noise suppression stays bounded and severity-aware",
    "The first known recoverable warning was suppressed; a repeat inside the window and the same message at error severity both remained reportable.",
    firstSuppressed && !repeatedSuppressed && !severeSuppressed,
  );
});
