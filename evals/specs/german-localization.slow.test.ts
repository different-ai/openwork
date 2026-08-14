import { expect } from "vitest";
import { evalIn, go, waitFor, waitUntilInteractive } from "@openwork/behaviors";
import { screenshot } from "@openwork/fraimz";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const title = appSpecsEnabled
  ? "German is selectable, applies immediately, and persists after reload"
  : "German localization skipped — needs: set OPENWORK_EVAL_APP_SPECS=1";

const visibleText = (text: string) =>
  `[...document.querySelectorAll("body *")].some((element) => {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden"
      && (element.textContent ?? "").trim() === ${JSON.stringify(text)};
  })`;

test.skipIf(!appSpecsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_APP_SPECS"] });

  await using app = await desktop({ name: "german-localization" });

  await go(app, "/settings/appearance");
  await waitUntilInteractive(app, { timeoutMs: 120_000 });
  await waitFor(app, visibleText("Language"), { timeoutMs: 30_000, label: "Appearance language setting" });
  await waitFor(app, `document.querySelector('[role="status"]') === null`, {
    timeoutMs: 30_000,
    label: "boot overlay dismissed before English screenshot",
  });
  expect(await evalIn(app, `document.documentElement.lang`)).toBe("en");
  evidence.fact(
    "Appearance contains the language selector",
    "A fresh English profile exposes the Language setting before another locale is selected.",
    true,
  );
  {
    const shot = await screenshot(app);
    evidence.claim(shot.hash, {
      ok: true,
      description: "English Appearance reference before switching languages.",
      results: [{
        expectation: "English Appearance reference",
        passed: true,
        evidence: "The fixed Electron window visibly shows Appearance and the Language control in English.",
      }],
      why: "",
      model: "deterministic DOM assertions",
      cached: false,
    });
  }

  await evalIn(app, `document.querySelector('[aria-label="Language"]')?.click()`);
  await waitFor(app, visibleText("Deutsch"), { timeoutMs: 30_000, label: "German language option" });
  expect(await evalIn(app, visibleText("Deutsch"))).toBe(true);
  evidence.fact(
    "German is offered as Deutsch",
    "Opening the language selector reveals the German locale under its native name.",
    true,
  );
  {
    const shot = await screenshot(app);
    evidence.claim(shot.hash, {
      ok: true,
      description: "The language selector visibly offers Deutsch.",
      results: [{
        expectation: "Deutsch is selectable",
        passed: true,
        evidence: "A deterministic DOM assertion confirms the visible Deutsch option.",
      }],
      why: "",
      model: "deterministic DOM assertions",
      cached: false,
    });
  }

  for (const event of [
    { type: "keyDown", key: "End", code: "End", windowsVirtualKeyCode: 35 },
    { type: "keyUp", key: "End", code: "End", windowsVirtualKeyCode: 35 },
    { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  ] as const) {
    await app.client.send("Input.dispatchKeyEvent", event);
  }
  await waitFor(app, `${visibleText("Sprache")} && ${visibleText("Darstellung")}`, {
    timeoutMs: 30_000,
    label: "German Appearance UI",
  });
  const selectedState = await evalIn(app, `({
    stored: localStorage.getItem("openwork.language"),
    htmlLang: document.documentElement.lang,
  })`);
  expect(selectedState).toEqual({ stored: "de", htmlLang: "de" });
  expect(await evalIn(app, `document.body.innerText`)).not.toContain("Light/dark");
  evidence.fact(
    "German applies immediately",
    "The same Appearance page switches to German while localStorage and the HTML language both become de.",
    true,
  );
  {
    const shot = await screenshot(app);
    evidence.claim(shot.hash, {
      ok: true,
      description: "German Appearance in the same Electron window immediately after selection.",
      results: [{
        expectation: "German Appearance after switching",
        passed: true,
        evidence: "DOM assertions confirm Sprache, Darstellung, openwork.language=de, and html lang=de.",
      }],
      why: "",
      model: "deterministic DOM assertions",
      cached: false,
    });
  }

  await evalIn(app, "location.reload(); true");
  await waitFor(app, `${visibleText("Sprache")} && document.documentElement.lang === "de"`, {
    timeoutMs: 30_000,
    label: "persisted German UI after reload",
  });
  await waitFor(app, `document.querySelector('[role="status"]') === null`, {
    timeoutMs: 30_000,
    label: "boot overlay dismissed after reload",
  });
  expect(await evalIn(app, `localStorage.getItem("openwork.language")`)).toBe("de");
  expect(await evalIn(app, visibleText("Language"))).toBe(false);
  evidence.fact(
    "German persists across reloads",
    "After reloading, the interface remains German and both persisted language values remain de.",
    true,
  );
  {
    const shot = await screenshot(app);
    evidence.claim(shot.hash, {
      ok: true,
      description: "Persisted German Appearance after a full page reload.",
      results: [{
        expectation: "German persists after reload",
        passed: true,
        evidence: "The reloaded page visibly remains German and no Language label returns.",
      }],
      why: "",
      model: "deterministic DOM assertions",
      cached: false,
    });
  }
});
