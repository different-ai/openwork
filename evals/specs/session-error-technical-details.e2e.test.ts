import { expect } from "vitest";
import { control, createAndSelectWorkspace, evalIn, seedSessions, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "session error cards expose provider diagnostics only in Developer mode"
  : "session error technical details skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

// Values from the seeded payload (eval.session_error.seed): an Anthropic 429
// with a JSON response body. None of these appear in the plain card text.
const CARD_TEXT = "Rate limit reached for claude-sonnet-4-5";
const DIAGNOSTIC_LINES = ["Error type: APIError", "Status: 429", "Provider: anthropic", "Code: rate_limit_error", "Retries: 3"];
const REQUEST_ID = "req_01JZK4W9N7X2Q8M3V5T6B1C0DE";
// Rendered with CSS uppercase, so compare case-insensitively.
const DEBUG_PANEL_TITLE = "react session debug";

type ErrorSurfaceProbe = {
  developerModeStored: string | null;
  cardVisible: boolean;
  cardText: string;
  toggleVisible: boolean;
  toggleExpanded: string | null;
  detailsVisible: boolean;
  detailsText: string;
  debugPanelVisible: boolean;
  bodyHasStatus: boolean;
  bodyHasRequestId: boolean;
};

function isErrorSurfaceProbe(value: unknown): value is ErrorSurfaceProbe {
  return typeof value === "object" && value !== null && "toggleVisible" in value && "cardText" in value;
}

const probeScript = `(() => {
  const card = document.querySelector('.border-destructive\\\\/30');
  const toggle = document.querySelector('[data-testid="session-error-details-toggle"]');
  const details = document.querySelector('[data-testid="session-error-details"]');
  const body = document.body.innerText;
  return {
    developerModeStored: window.localStorage.getItem('openwork.developerMode'),
    cardVisible: card instanceof HTMLElement,
    cardText: card instanceof HTMLElement ? card.innerText.replace(/\\s+/g, ' ').trim() : '',
    toggleVisible: toggle instanceof HTMLElement,
    toggleExpanded: toggle?.getAttribute('aria-expanded') ?? null,
    detailsVisible: details instanceof HTMLElement,
    detailsText: details instanceof HTMLElement ? details.innerText : '',
    debugPanelVisible: body.toLowerCase().includes(${JSON.stringify(DEBUG_PANEL_TITLE)}),
    bodyHasStatus: body.includes('Status: 429'),
    bodyHasRequestId: body.includes(${JSON.stringify(REQUEST_ID)}),
  };
})()`;

async function probe(app: Awaited<ReturnType<typeof desktop>>): Promise<ErrorSurfaceProbe> {
  const result = await evalIn(app, probeScript);
  if (!isErrorSurfaceProbe(result)) throw new Error(`Error surface was not readable: ${JSON.stringify(result)}`);
  return result;
}

/** Toggle Developer mode the way a person does: ⌘K → "Enable/Disable Developer mode". */
async function toggleDeveloperMode(app: Awaited<ReturnType<typeof desktop>>, next: "on" | "off") {
  // Locale text is "Enable Developer Mode"; match case-insensitively so a copy tweak doesn't break the flow.
  const label = next === "on" ? "enable developer mode" : "disable developer mode";
  await control(app, "command_palette.open");
  await waitFor(
    app,
    `[...document.querySelectorAll('[data-slot="command-item"]')].some((item) => (item.textContent ?? '').toLowerCase().includes(${JSON.stringify(label)}))`,
    { timeoutMs: 15_000, label: `palette shows “${label}”` },
  );
  const clicked = await evalIn(app, `(() => {
    const item = [...document.querySelectorAll('[data-slot="command-item"]')]
      .find((candidate) => (candidate.textContent ?? '').toLowerCase().includes(${JSON.stringify(label)}));
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`);
  expect(clicked).toBe(true);
  await waitFor(app, `window.localStorage.getItem('openwork.developerMode') === ${JSON.stringify(next === "on" ? "1" : "0")}`, {
    timeoutMs: 10_000,
    label: `Developer mode persisted ${next}`,
  });
}

test.skipIf(!enabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({ name: "session-error-technical-details" });
  await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-session-error-details-${Date.now()}`,
  });
  await seedSessions(app, ["Session error proof"]);
  await waitFor(
    app,
    `window.__openworkControl.listActions().some((action) => action.id === "eval.session_error.seed" && !action.disabled)`,
    { timeoutMs: 30_000, label: "session error seed control ready" },
  );
  await control(app, "eval.session_error.seed");
  await waitFor(app, `Boolean(document.querySelector('.border-destructive\\\\/30'))`, {
    timeoutMs: 15_000,
    label: "session error card",
  });

  // End users (Developer mode off): the plain card and nothing diagnostic.
  const plain = await probe(app);
  expect(plain.developerModeStored).not.toBe("1");
  expect(plain.cardVisible).toBe(true);
  expect(plain.cardText).toContain(CARD_TEXT);
  expect(plain.toggleVisible).toBe(false);
  expect(plain.bodyHasStatus).toBe(false);
  expect(plain.bodyHasRequestId).toBe(false);
  expect(plain.debugPanelVisible).toBe(false);
  evidence.recordAssertionEvidence(
    "With Developer mode off, a failed turn shows only the plain error card",
    `Card read “${plain.cardText}”; no Technical details toggle, no status/provider/request id, and no session debug panel were in the DOM.`,
    true,
  );

  // Developer mode on: the surface reacts live (no reload) and reveals diagnostics.
  await toggleDeveloperMode(app, "on");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="session-error-details-toggle"]'))`, {
    timeoutMs: 10_000,
    label: "Technical details toggle after enabling Developer mode",
  });
  const collapsed = await probe(app);
  expect(collapsed.cardText).toContain(CARD_TEXT);
  expect(collapsed.toggleVisible).toBe(true);
  expect(collapsed.toggleExpanded).toBe("false");
  expect(collapsed.detailsVisible).toBe(false);
  expect(collapsed.bodyHasStatus).toBe(false);
  expect(collapsed.debugPanelVisible).toBe(true);
  evidence.recordAssertionEvidence(
    "Enabling Developer mode reaches the session surface without a reload",
    "The Technical details toggle appeared collapsed under the same card, and the React Session Debug panel (gated on the same flag) became visible.",
    true,
  );

  const opened = await evalIn(app, `(() => {
    const toggle = document.querySelector('[data-testid="session-error-details-toggle"]');
    if (!(toggle instanceof HTMLButtonElement)) return false;
    toggle.click();
    return true;
  })()`);
  expect(opened).toBe(true);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="session-error-details"]'))`, {
    timeoutMs: 10_000,
    label: "Technical details panel open",
  });
  const expanded = await probe(app);
  expect(expanded.toggleExpanded).toBe("true");
  expect(expanded.detailsVisible).toBe(true);
  for (const line of DIAGNOSTIC_LINES) expect(expanded.detailsText).toContain(line);
  expect(expanded.detailsText).toContain(REQUEST_ID);
  expect(expanded.detailsText).toContain("Copy details");
  // The headline card itself is unchanged: diagnostics live in the panel, not the message.
  expect(expanded.cardText.startsWith(CARD_TEXT)).toBe(true);
  evidence.recordAssertionEvidence(
    "Opening Technical details shows the full provider diagnostic payload with a copy action",
    `Panel contained ${DIAGNOSTIC_LINES.join(", ")} and the provider request id ${REQUEST_ID}, plus a “Copy details” control.`,
    true,
  );

  // Developer mode off again: diagnostics leave; the error itself stays.
  await toggleDeveloperMode(app, "off");
  await waitFor(app, `!document.querySelector('[data-testid="session-error-details-toggle"]')`, {
    timeoutMs: 10_000,
    label: "Technical details toggle removed after disabling Developer mode",
  });
  const hidden = await probe(app);
  expect(hidden.cardVisible).toBe(true);
  expect(hidden.cardText).toContain(CARD_TEXT);
  expect(hidden.toggleVisible).toBe(false);
  expect(hidden.detailsVisible).toBe(false);
  expect(hidden.bodyHasStatus).toBe(false);
  expect(hidden.bodyHasRequestId).toBe(false);
  expect(hidden.debugPanelVisible).toBe(false);
  evidence.recordAssertionEvidence(
    "Disabling Developer mode removes diagnostics while the error card remains",
    "Toggle, panel, request id, and debug panel all left the DOM; the plain card was still present.",
    true,
  );
});
