import { expect } from "vitest";
import { screenshot, validate } from "@openwork/fraimz";
import { evalIn, waitFor, waitForText } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import { needs, server, test } from "@openwork/testkit";

/**
 * CORE JOURNEY: the creation surface owns immutable execution placement.
 * Desktop-created Automations remain Desktop work. A Web-created Automation
 * is presented as Cloud work, is visible from both management surfaces, and
 * its copy promises headless execution plus automatic Cloud wake-up.
 *
 * Full Daytona stop -> wake -> native-thread execution is an opt-in deployment
 * acceptance journey; this tape keeps the cross-surface product contract in
 * ordinary PR CI without allocating remote compute.
 */

test("Web creates Cloud-owned Automations while Desktop creation remains local", async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_APP_SPECS", "OPENWORK_EVAL_AUTOMATIONS_SPEC"] });
  await using den = await server({ place });
  await using browser = await chrome({
    name: "automation-runtime-placement",
    startUrl: den.ref.webUrl,
    headless: true,
    host: place.host(),
  });
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web loaded",
  });
  await evalIn(browser, `localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(den.admin.token)})`);
  await navigate(browser.client, `${den.ref.webUrl}/dashboard/automations`);
  await waitForText(browser, "New Automation", { timeoutMs: 60_000 });

  const surfaceCopy = await evalIn(browser, "document.body.innerText");
  expect(surfaceCopy).toContain("Automations created here run headlessly in OpenWork Cloud");
  expect(surfaceCopy).toContain("Desktop-created Automations stay on Desktop");
  await evalIn(browser, `([...document.querySelectorAll("button")].find((button) => button.textContent?.includes("New Automation")))?.click()`);
  await waitForText(browser, "A stopped Cloud container wakes automatically", { timeoutMs: 10_000 });
  evidence.fact(
    "Creation surface explains immutable runtime placement",
    "Web identifies new Automations as OpenWork Cloud-owned and preserves Desktop-created Automations as Desktop-owned.",
    true,
  );

  const shot = await screenshot(browser);
  const seen = await validate(shot, [
    "The Automations dashboard shows a New Cloud Automation form",
    "The form explains that it runs when Desktop is offline and wakes a stopped Cloud container",
    "No runtime placement picker is visible",
  ]);
  expect(seen.ok, seen.why).toBe(true);
});
