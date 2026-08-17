import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import { readActiveWorkspaceId } from "@openwork/cdp";
import {
  createLocalWorkspaceViaUi,
  evalIn,
  go,
  waitFor,
} from "@openwork/behaviors";
import { screenshot } from "@openwork/fraimz";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const title = appSpecsEnabled
  ? "German primary-path copy is complete, concise, and usable"
  : "German primary-path copy skipped — needs: set OPENWORK_EVAL_APP_SPECS=1";

const visibleText = (text: string) =>
  `[...document.querySelectorAll("body *")].some((element) => {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden"
      && (element.textContent ?? "").trim() === ${JSON.stringify(text)};
  })`;

const noInteractiveOverflow = `
  [...document.querySelectorAll("button, [role=menuitem], [role=tab], label")]
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && element.scrollWidth > element.clientWidth + 1;
    })
    .map((element) => (element.textContent ?? "").trim())
    .filter(Boolean)
`;

test.skipIf(!appSpecsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_APP_SPECS"] });

  let workspacePath = "";
  onTestFinished(async () => {
    if (workspacePath) await rm(workspacePath, { recursive: true, force: true });
  });

  await using app = await desktop({ name: "german-primary-path-copy" });
  const take = async (description: string, expectation: string, detail: string) => {
    const shot = await screenshot(app);
    evidence.claim(shot.hash, {
      ok: true,
      description,
      results: [{ expectation, passed: true, evidence: detail }],
      why: "",
      model: "deterministic DOM assertions",
      cached: false,
    });
  };

  await go(app, "/settings/appearance");
  await waitFor(app, visibleText("Language"), { timeoutMs: 30_000, label: "English language setting" });
  await waitFor(app, `document.querySelector('[role="status"]') === null`, {
    timeoutMs: 30_000,
    label: "boot overlay dismissed",
  });
  await evalIn(app, `document.querySelector('[aria-label="Language"]')?.click()`);
  await waitFor(app, visibleText("Deutsch"), { timeoutMs: 30_000, label: "Deutsch option" });
  for (const event of [
    { type: "keyDown", key: "End", code: "End", windowsVirtualKeyCode: 35 },
    { type: "keyUp", key: "End", code: "End", windowsVirtualKeyCode: 35 },
    { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  ] as const) {
    await app.client.send("Input.dispatchKeyEvent", event);
  }
  await waitFor(app, `${visibleText("Darstellung")} && document.documentElement.lang === "de"`, {
    timeoutMs: 30_000,
    label: "German locale active",
  });
  expect(await evalIn(app, `localStorage.getItem("openwork.language")`)).toBe("de");

  // Voiceover 1–2: the same settings overview is concise and fully German on this head.
  await go(app, "/settings/general");
  await waitFor(app, `${visibleText("Übersicht aller Einstellungen")} && ${visibleText("OpenWork mitgestalten")}`, {
    timeoutMs: 30_000,
    label: "German settings overview",
  });
  const settingsText = String(await evalIn(app, `document.body.innerText`));
  for (const text of ["Präferenzen", "Berechtigungen", "KI-Anbieter", "Darstellung", "Umgebung", "Wiederherstellung"]) {
    expect(settingsText).toContain(text);
  }
  for (const text of ["Preferences", "Permissions", "AI Providers", "Appearance", "Environment", "Recovery"]) {
    expect(settingsText).not.toContain(text);
  }
  expect(await evalIn(app, noInteractiveOverflow)).toEqual([]);
  evidence.fact("Settings overview is fully German", "The previously hard-coded navigation and overview cards are German and fit the fixed viewport.", true);
  await take("German settings overview on the follow-up head.", "German settings overview", "All targeted cards and navigation labels are German with no interactive overflow.");

  // Voiceover 3: traverse the real local onboarding flow with a temporary folder.
  await go(app, "/welcome");
  await waitFor(app, `${visibleText("Willkommen bei OpenWork")} && ${visibleText("Ohne Cloud verwenden")}`, {
    timeoutMs: 30_000,
    label: "German welcome",
  });
  await evalIn(app, `document.querySelector('[data-testid="welcome-use-without-cloud"]')?.click()`);
  await waitFor(app, `${visibleText("Daytona-Ordnerpfad")} && ${visibleText("Diesen Ordner verwenden")}`, {
    timeoutMs: 15_000,
    label: "German folder form",
  });
  expect(await evalIn(app, noInteractiveOverflow)).toEqual([]);
  await take("German local-folder onboarding reached through the real Welcome action.", "German folder selection", "The local folder label and action are German and visible without overflow.");

  workspacePath = await mkdtemp(join(tmpdir(), "openwork-german-primary-"));
  const workspace = await createLocalWorkspaceViaUi(app, { path: workspacePath });
  expect(workspace.entrypoint).toBe("manual-folder");
  await waitFor(app, `${visibleText("Modell für die erste Aufgabe")} && ${visibleText("Kostenloses Modell verwenden")}`, {
    timeoutMs: 120_000,
    label: "German provider step",
  });
  expect(String(await evalIn(app, `document.body.innerText`))).not.toContain("Power your first task");
  expect(await evalIn(app, noInteractiveOverflow)).toEqual([]);
  await take("German provider selection after creating a real temporary workspace.", "German provider onboarding", "Provider choices and the skip action are German and fit the viewport.");

  await evalIn(app, `document.querySelector('[data-testid="provider-selection-skip"]')?.click()`);
  await waitFor(app, visibleText("Wie haben Sie von OpenWork erfahren?"), {
    timeoutMs: 90_000,
    label: "German attribution step",
  });
  expect(String(await evalIn(app, `document.body.innerText`))).not.toContain("How did you hear about OpenWork?");
  expect(await evalIn(app, noInteractiveOverflow)).toEqual([]);
  await take("German attribution step reached through the real provider skip action.", "German attribution onboarding", "The attribution question and choices are German and not clipped.");

  await evalIn(app, `document.querySelector('[data-testid="attribution-skip"]')?.click()`);
  await waitFor(app, `Boolean(localStorage.getItem("openwork.react.activeWorkspace"))
    || (window.location.hash.includes("/workspace/") && window.location.hash.includes("/session"))`, {
    timeoutMs: 180_000,
    label: "workspace selected after onboarding",
  });
  const workspaceId = await readActiveWorkspaceId(app.client, { timeoutMs: 30_000 });
  expect(workspaceId).toBeTruthy();
  await go(app, `/workspace/${workspaceId ?? ""}/session`);

  // Voiceover 4–5: German, Germany-specific suggestions insert natural du-form prompts.
  await waitFor(app, `${visibleText("Was möchten Sie erledigen?")} && ${visibleText("CSV für Excel erstellen")}`, {
    timeoutMs: 120_000,
    label: "German session suggestions",
  });
  const sessionText = String(await evalIn(app, `document.body.innerText`));
  expect(sessionText).toContain("Angebote vergleichen");
  expect(sessionText).toContain("Deutsche Zahlen- und Datumsformate verwenden.");
  expect(sessionText).not.toContain("Clean up a spreadsheet");
  expect(sessionText).not.toContain("Automate a web task");
  expect(await evalIn(app, noInteractiveOverflow)).toEqual([]);
  await take("German session empty state with Germany-specific task suggestions.", "German task suggestions", "The visible cards use German examples and fit the fixed viewport.");

  await evalIn(app, `document.querySelector('[data-testid="session-suggestion-1"]')?.click()`);
  const spreadsheetPrompt = "Erstelle eine CSV-Datei mit 20 fiktiven deutschen Kundendatensätzen: Name, E-Mail-Adresse, Unternehmen, Ort und Umsatz in Euro. Verwende ein Semikolon als Trennzeichen sowie deutsche Zahlen- und Datumsformate. Fasse die Daten anschließend kurz zusammen.";
  await waitFor(app, `document.querySelector('[contenteditable="true"]')?.innerText === ${JSON.stringify(spreadsheetPrompt)}`, {
    timeoutMs: 30_000,
    label: "German du-form prompt inserted",
  });
  expect(String(await evalIn(app, `document.querySelector('[contenteditable="true"]')?.innerText ?? ""`))).toBe(spreadsheetPrompt);
  await take("The selected German suggestion inserts its complete du-form prompt into the real composer.", "German prompt insertion", "The composer contains the exact Germany-specific prompt after a real card click.");

  // Voiceover 6: representative model and account menus remain German and usable.
  await evalIn(app, `document.querySelector('[aria-label="Modell wechseln"]')?.click()`);
  await waitFor(app, `${visibleText("Eigene API-Schlüssel")} && ${visibleText("Alle Modelle")}`, {
    timeoutMs: 30_000,
    label: "German model menu",
  });
  const modelMenuText = String(await evalIn(app, `document.body.innerText`));
  for (const text of ["Your API keys", "All models", "Add your keys", "Connect more providers"]) {
    expect(modelMenuText).not.toContain(text);
  }
  expect(await evalIn(app, noInteractiveOverflow)).toEqual([]);
  await take("German compact model menu opened from the real composer control.", "German model menu", "Model search and provider actions are German and not clipped.");

  await app.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await app.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await evalIn(app, `document.querySelector('[data-testid="account-status-menu"]')?.click()`);
  await waitFor(app, visibleText("Anmelden"), { timeoutMs: 30_000, label: "German account menu" });
  const accountMenuText = String(await evalIn(app, `document.body.innerText`));
  expect(accountMenuText).toContain("Cloud synchronisieren");
  expect(accountMenuText).not.toContain("Sign in");
  expect(accountMenuText).not.toContain("Sync with OpenWork Cloud");
  expect(await evalIn(app, noInteractiveOverflow)).toEqual([]);
  await take("German account and status menu opened from the real sidebar control.", "German account menu", "Account actions are German, usable, and fit the fixed viewport.");
});
