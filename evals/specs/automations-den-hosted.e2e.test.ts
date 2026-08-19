import { expect } from "vitest";
import { screenshot, validate } from "@openwork/test-evidence";
import {
  clickButton,
  createOrgConnection,
  evalIn,
  go,
  visibleText,
  waitFor,
  waitForText,
} from "@openwork/behaviors";
import { app, mcpMock, needs, server, test } from "@openwork/testkit";
import type { Surface } from "@openwork/cdp";

/**
 * CORE JOURNEY: a person creates an active Automation in the main OpenWork
 * app, keeps its authenticated desktop runner connected, and Den wakes that
 * runner to claim the scheduled occurrence exactly once. The desktop executes
 * it with the selected model and a current OpenWork Connect integration.
 * The app reveals the durable receipt and execution thread. Deactivation
 * stops future claims without becoming a cancellation control; reactivation
 * computes a new future occurrence.
 *
 * Faithfulness notes:
 *  - Den notifications carry no assignment; the runner claims over HTTP.
 *  - The mock Connect server is the witness that the desktop used an integration.
 *  - The product UI is the control plane throughout; this spec does not seed an
 *    Automation directly in MySQL or call a hidden scheduler endpoint.
 */

const requirements = {
  model: "tool-capable" as const,
  optIn: ["OPENWORK_EVAL_E2E_TESTS", "OPENWORK_EVAL_AUTOMATIONS_E2E_TEST"],
};

async function setField(surface: Surface, label: string, value: string): Promise<void> {
  const changed = await evalIn(surface, `(() => {
    const labels = [...document.querySelectorAll('label')];
    const label = labels.find((candidate) => (candidate.textContent ?? '').trim().includes(${JSON.stringify(label)}));
    const id = label?.getAttribute('for');
    const field = id ? document.getElementById(id) : label?.querySelector('input, textarea, select');
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
    setter?.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  expect(changed, `Could not set ${label}`).toBe(true);
}

test("Den schedules and a connected desktop runner executes an Automation", { timeout: 1_200_000 }, async ({ evidence, place }) => {
  needs(requirements);

  await using den = await server({
    place,
    mocks: { connector: mcpMock({ port: 3981, allowUnauthenticatedMcp: true }) },
  });
  const connector = den.mocks.connector;
  const stamp = Date.now();
  const marker = `den-automation-${stamp}`;
  await createOrgConnection(den.admin, {
    name: `Automation witness ${stamp}`,
    url: connector.mcpUrl,
    authType: "none",
    credentialMode: "shared",
    access: { orgWide: true },
  });

  const submittedSince = new Date().toISOString();

  const desktop = await app({ den, as: "admin", place });
  await go(desktop, "/automations");
  await waitForText(desktop, "Automations", { timeoutMs: 60_000 });
  await clickButton(desktop, "New Automation");
  await setField(desktop, "Name", `Daily Connect check ${stamp}`);
  await setField(
    desktop,
    "Instructions",
    `Use search_capabilities to find the echo integration, call it with text exactly ${marker}, then summarize the result.`,
  );
  await setField(desktop, "Schedule", "daily");
  const due = new Date(Date.now() + 2 * 60_000);
  const scheduledTime = `${String(due.getUTCHours()).padStart(2, "0")}:${String(due.getUTCMinutes()).padStart(2, "0")}`;
  await setField(desktop, "Time", scheduledTime);
  await setField(desktop, "Timezone", "UTC");

  const createScreen = await visibleText(desktop);
  expect(createScreen).not.toMatch(/draft|permission picker|review automation|approve/i);
  expect(createScreen).toContain("Den keeps the schedule and run history");
  expect(createScreen).toContain("local OpenCode runtime");
  await clickButton(desktop, "Create and activate");
  await waitForText(desktop, "Active", { timeoutMs: 60_000 });
  evidence.recordAssertionEvidence(
    "Creation is immediately active",
    "The detail page showed Active without a draft, review, or permission step.",
    true,
  );
  const calls = await connector.toolCalls({
    name: "mock_echo",
    atLeast: 1,
    sinceIso: submittedSince,
    timeoutMs: 5 * 60_000,
  });
  expect(calls.filter((call) => String(call.args.text ?? "").includes(marker))).toHaveLength(1);
  evidence.recordAssertionEvidence(
    "The desktop runner used the owner's current Connect integration exactly once",
    `The mock connector observed one call carrying ${marker}.`,
    true,
  );

  await waitForText(desktop, "succeeded", { timeoutMs: 120_000 });
  // The desktop can pull focus to the freshly executed session thread moments
  // after the run succeeds. Recover from wherever focus landed: the receipt
  // itself, the automation detail page (which owns the Open button), or the
  // automations list (open the card first), until the receipt's full content —
  // timeline, RESULT heading, and the marker — is visible in one stable view.
  let receipt = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const onReceipt = await evalIn(
        desktop,
        `document.body.innerText.includes('Run receipt and event timeline') && !document.body.innerText.includes('No run selected.')`,
      );
      if (!onReceipt) {
        const onDetail = await evalIn(
          desktop,
          `[...document.querySelectorAll('button')].some((element) => (element.textContent ?? '').trim() === 'Open' && !element.disabled)`,
        );
        if (!onDetail) {
          await go(desktop, "/automations");
          await waitForText(desktop, `Daily Connect check ${stamp}`, { timeoutMs: 30_000 });
          const openedCard = await evalIn(desktop, `(() => {
            const card = [...document.querySelectorAll('button, [role=button], a')]
              .find((element) => (element.textContent ?? '').includes(${JSON.stringify(`Daily Connect check ${stamp}`)}));
            if (!(card instanceof HTMLElement)) return false;
            card.click();
            return true;
          })()`);
          expect(openedCard).toBe(true);
          await waitForText(desktop, "succeeded", { timeoutMs: 60_000 });
        }
        await clickButton(desktop, "Open");
      }
      await waitFor(
        desktop,
        `document.body.innerText.includes('Run receipt and event timeline') && !document.body.innerText.includes('No run selected.') && document.body.innerText.includes('RESULT') && document.body.innerText.includes(${JSON.stringify(marker)})`,
        { timeoutMs: 45_000, label: "stable run receipt with result" },
      );
      receipt = await visibleText(desktop);
      break;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  expect(receipt).toContain("succeeded");
  expect(receipt).toContain("RESULT");
  expect(receipt).toMatch(/execution thread/i);
  expect(receipt).toMatch(/desktop/i);
  {
    const shot = await screenshot(desktop);
    const seen = await validate(shot, [
      "An Automation run receipt is visible with a succeeded status and a desktop execution thread",
      "The selected receipt includes the result summary and identifies Desktop as the execution location",
      "No draft, review, permission picker, or crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  await clickButton(desktop, "Deactivate");
  await waitForText(desktop, "Inactive", { timeoutMs: 30_000 });
  await waitFor(
    desktop,
    `[...document.querySelectorAll('span')].some((label) => label.textContent?.trim() === 'Next run' && label.parentElement?.innerText.includes('—'))`,
    { timeoutMs: 30_000, label: "future due time cleared after deactivation" },
  );
  await clickButton(desktop, "Activate");
  await waitForText(desktop, "Active", { timeoutMs: 30_000 });
  await waitFor(
    desktop,
    `[...document.querySelectorAll('span')].some((label) => label.textContent?.trim() === 'Next run' && !label.parentElement?.innerText.includes('—'))`,
    { timeoutMs: 30_000, label: "next future occurrence recalculated" },
  );
});
