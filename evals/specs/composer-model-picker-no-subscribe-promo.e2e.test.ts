import { expect } from "vitest";
import { evalIn, go, waitFor } from "@openwork/behaviors";
import { app, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `composer model picker promo removal skipped — needs: ${missingRequirements.join(", ")}`
  : "the composer model pickers keep their controls without the OpenWork Models subscribe promo";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test(title, async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({ place });
  await using desktop = await app({ den, as: "admin", place });

  await go(desktop, `/workspace/${desktop.workspaceId}/session`);
  await waitFor(desktop, `[...document.querySelectorAll('button[aria-label="Change model"]')]
    .some((trigger) => (trigger.textContent ?? '').trim() === 'Big Pickle')`, {
    timeoutMs: 60_000,
    label: "composer model selector",
  });

  const compactOpened = await evalIn(desktop, `(() => {
    const trigger = [...document.querySelectorAll('button[aria-label="Change model"]')]
      .find((candidate) => (candidate.textContent ?? '').trim() === 'Big Pickle');
    if (!(trigger instanceof HTMLButtonElement)) return false;
    trigger.click();
    return true;
  })()`);
  expect(compactOpened).toBe(true);
  await waitFor(desktop, `Boolean(document.querySelector('[data-slot="model-select-root"]'))`, {
    timeoutMs: 20_000,
    label: "model quick controls",
  });
  const modelPaneOpened = await evalIn(desktop, `(() => {
    const root = document.querySelector('[data-slot="model-select-root"]');
    const model = root && [...root.querySelectorAll('button')]
      .find((button) => button.querySelector('span')?.textContent?.trim() === 'Model');
    if (!(model instanceof HTMLButtonElement)) return false;
    model.click();
    return true;
  })()`);
  expect(modelPaneOpened).toBe(true);
  await waitFor(desktop, `Boolean(document.querySelector('[data-slot="popover-content"] input[placeholder="Search models..."]'))`, {
    timeoutMs: 20_000,
    label: "compact model picker",
  });

  const compact = await evalIn(desktop, `(() => {
    const popover = document.querySelector('[data-slot="popover-content"]');
    if (!(popover instanceof HTMLElement)) return null;
    const text = popover.innerText.replace(/\\s+/g, " ").trim();
    const hasExactText = (expected) => [...popover.querySelectorAll("*")]
      .some((element) => (element.textContent ?? "").replace(/\\s+/g, " ").trim() === expected);
    return {
      search: Boolean(popover.querySelector('input[placeholder="Search models..."]')),
      allModels: [...popover.querySelectorAll("button")]
        .some((button) => (button.textContent ?? "").trim() === "All models"),
      connectMore: [...popover.querySelectorAll("button")]
        .some((button) => (button.textContent ?? "").trim() === "Connect more providers"),
      yourApiKeys: text.includes("Your API keys"),
      addYourKeys: hasExactText("Add your keys"),
      hostedMarker: text.includes("hosted · no API keys"),
      unlockSentence: text.includes("One subscription unlocks these in every workspace."),
      enableAction: hasExactText("Enable →"),
      signInAction: hasExactText("Sign in →"),
      hideAction: hasExactText("Hide"),
    };
  })()`);
  expect(compact).toEqual({
    search: true,
    allModels: true,
    connectMore: true,
    yourApiKeys: false,
    addYourKeys: false,
    hostedMarker: false,
    unlockSentence: false,
    enableAction: false,
    signInAction: false,
    hideAction: false,
  });
  evidence.recordAssertionEvidence(
    "The signed-in test app's compact model picker retains search and All models without the removed subscribe promo",
    `Compact picker controls and removed-marker checks: ${JSON.stringify(compact)}.`,
    isRecord(compact)
      && compact.search === true
      && compact.allModels === true
      && compact.connectMore === true
      && compact.yourApiKeys === false
      && compact.addYourKeys === false
      && compact.hostedMarker === false
      && compact.unlockSentence === false
      && compact.enableAction === false
      && compact.signInAction === false
      && compact.hideAction === false,
  );

  const allModelsClicked = await evalIn(desktop, `(() => {
    const popover = document.querySelector('[data-slot="popover-content"]');
    const button = [...(popover?.querySelectorAll("button") ?? [])]
      .find((candidate) => (candidate.textContent ?? "").trim() === "All models");
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  expect(allModelsClicked).toBe(true);
  await waitFor(desktop, `Boolean(document.querySelector('[data-slot="dialog-content"] input[placeholder="Search providers and models..."]'))`, {
    timeoutMs: 20_000,
    label: "full Models dialog",
  });

  const full = await evalIn(desktop, `(() => {
    const dialog = document.querySelector('[data-slot="dialog-content"]');
    if (!(dialog instanceof HTMLElement)) return null;
    const text = dialog.innerText.replace(/\\s+/g, " ").trim();
    const hasExactText = (expected) => [...dialog.querySelectorAll("*")]
      .some((element) => (element.textContent ?? "").replace(/\\s+/g, " ").trim() === expected);
    return {
      title: hasExactText("Models"),
      subtitle: hasExactText("Select a model for this session."),
      search: Boolean(dialog.querySelector('input[placeholder="Search providers and models..."]')),
      done: [...dialog.querySelectorAll("button")]
        .some((button) => (button.textContent ?? "").trim() === "Done"),
      hideButton: Boolean(dialog.querySelector('button[aria-label="Hide OpenWork Models"]')),
      subscribeSentence: text.includes("Subscribe to use hosted frontier models in this workspace."),
      unlockSentence: text.includes("Sign in to unlock hosted frontier models for your team."),
      subscribeAction: hasExactText("Subscribe"),
    };
  })()`);
  expect(full).toEqual({
    title: true,
    subtitle: true,
    search: true,
    done: true,
    hideButton: false,
    subscribeSentence: false,
    unlockSentence: false,
    subscribeAction: false,
  });
  evidence.recordAssertionEvidence(
    "All models opens the full session Models dialog without the removed subscribe promo",
    `Full dialog controls and removed-marker checks: ${JSON.stringify(full)}.`,
    isRecord(full)
      && full.title === true
      && full.subtitle === true
      && full.search === true
      && full.done === true
      && full.hideButton === false
      && full.subscribeSentence === false
      && full.unlockSentence === false
      && full.subscribeAction === false,
  );
});
