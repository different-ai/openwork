import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import { photoRoll, screenshot, validate } from "@openwork/fraimz";
import { desktop } from "@openwork/hosts";

const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const title = appSpecsEnabled
  ? "Library shows readiness state tabs"
  : "Library state tabs skipped: set OPENWORK_EVAL_APP_SPECS=1 to opt in";
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

test.skipIf(!appSpecsEnabled)(title, async () => {
  await using app = await desktop({ name: "library-state-tabs" });
  await createAndSelectWorkspace(app, { path: repoRoot });
  await evalIn(app, `(() => {
    window.location.hash = "#/settings/general";
    return true;
  })()`);
  await waitFor(
    app,
    `[...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Library")`,
    { timeoutMs: 60_000, label: "Library settings navigation entry" },
  );
  const openedLibrary = await evalIn(app, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((entry) => entry.textContent?.trim() === "Library");
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  })()`);
  expect(openedLibrary).toBe(true);
  await waitFor(
    app,
    `window.location.hash.includes("/settings/extensions")
      && [...document.querySelectorAll("h1, h2")].some((heading) => heading.textContent?.trim() === "Library")
      && Boolean(document.querySelector('[role="tablist"][aria-label="Library state"]'))
      && [...document.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent?.trim() === "All")
      && [...document.querySelectorAll('[role="tab"]')].some((tab) => (tab.textContent ?? "").includes("Ready to use"))`,
    { timeoutMs: 60_000, label: "Library title and state tabs" },
  );

  const headerHasConnectedCount = await evalIn(app, `(() => {
    const description = [...document.querySelectorAll("p")]
      .find((entry) => entry.textContent?.includes("Skills, connections, and tools your agent can use."));
    return /apps? connected/i.test(description?.parentElement?.textContent ?? "");
  })()`);
  expect(headerHasConnectedCount).toBe(false);
  const descriptionRenderedOnce = await evalIn(
    app,
    `document.body.innerText.split("Skills, connections, and tools your agent can use.").length - 1`,
  );
  expect(descriptionRenderedOnce).toBe(1);

  const clickedReady = await evalIn(app, `(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')]
      .find((entry) => (entry.textContent ?? "").includes("Ready to use"));
    if (!(tab instanceof HTMLElement)) return false;
    tab.click();
    return true;
  })()`);
  expect(clickedReady).toBe(true);
  await waitFor(
    app,
    `window.location.hash.endsWith("/extensions/ready")
      && document.querySelectorAll("[data-inventory-group]").length > 0
      && [...document.querySelectorAll("[data-inventory-group]")]
        .every((row) => row.getAttribute("data-inventory-group") === "ready")`,
    { timeoutMs: 30_000, label: "Ready Library deep link and rows" },
  );

  const hasNeedsSignin = await evalIn(
    app,
    `[...document.querySelectorAll('[role="tab"]')].some((tab) => (tab.textContent ?? "").includes("Needs your sign-in"))`,
  );
  if (hasNeedsSignin === true) {
    const clicked = await evalIn(app, `(() => {
      const tab = [...document.querySelectorAll('[role="tab"]')]
        .find((entry) => (entry.textContent ?? "").includes("Needs your sign-in"));
      if (!(tab instanceof HTMLElement)) return false;
      tab.click();
      return true;
    })()`);
    expect(clicked).toBe(true);
    await waitFor(
      app,
      `window.location.hash.includes("/extensions/needs-sign-in")
        && document.querySelectorAll("[data-inventory-group]").length > 0
        && [...document.querySelectorAll("[data-inventory-group]")]
          .every((row) => row.getAttribute("data-inventory-group") === "needs_signin")`,
      { timeoutMs: 30_000, label: "only needs-signin Library rows" },
    );
  }

  await using roll = photoRoll("library-state-tabs");
  const shot = await screenshot(app);
  const seen = await validate(shot, ["A Library settings page shows state tabs with counts"]);
  expect(seen.ok, seen.why).toBe(true);
  await roll.add(shot, seen);
});
