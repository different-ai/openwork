import { expect } from "vitest";
import { screenshot, validate } from "@openwork/fraimz";
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
  optIn: ["OPENWORK_EVAL_APP_SPECS", "OPENWORK_EVAL_AUTOMATIONS_SPEC"],
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

test("Den schedules and a connected desktop runner executes an Automation", async ({ evidence, place }) => {
  needs(requirements);

  await using den = await server({
    place,
    mocks: { connector: mcpMock({ port: 3981 }) },
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

  const due = new Date(Date.now() + 2 * 60_000);
  const scheduledTime = `${String(due.getUTCHours()).padStart(2, "0")}:${String(due.getUTCMinutes()).padStart(2, "0")}`;
  const submittedSince = new Date().toISOString();

  const desktop = await app({ den, as: "admin", place });
  await go(desktop, `/workspace/${desktop.workspaceId}/automations`);
  await waitForText(desktop, "Automations", { timeoutMs: 60_000 });
  await clickButton(desktop, "Create Automation");
  await setField(desktop, "Name", `Daily Connect check ${stamp}`);
  await setField(
    desktop,
    "Instructions",
    `Use search_capabilities to find the echo integration, call it with text exactly ${marker}, then summarize the result.`,
  );
  await setField(desktop, "Schedule", "daily");
  await setField(desktop, "Time", scheduledTime);
  await setField(desktop, "Timezone", "UTC");
  await setField(desktop, "Model", process.env.OPENWORK_EVAL_MODEL ?? "");

  const createScreen = await visibleText(desktop);
  expect(createScreen).not.toMatch(/draft|permission picker|review automation|approve/i);
  expect(createScreen).toContain("Den keeps the schedule and run history");
  expect(createScreen).toContain("local OpenCode runtime");
  await clickButton(desktop, "Create Automation");
  await waitForText(desktop, "Active", { timeoutMs: 60_000 });
  evidence.fact(
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
  evidence.fact(
    "The desktop runner used the owner's current Connect integration exactly once",
    `The mock connector observed one call carrying ${marker}.`,
    true,
  );

  await waitForText(desktop, "Succeeded", { timeoutMs: 120_000 });
  await waitForText(desktop, marker, { timeoutMs: 60_000 });
  const receipt = await visibleText(desktop);
  expect(receipt).toMatch(/execution thread/i);
  expect(receipt).toMatch(/desktop/i);
  {
    const shot = await screenshot(desktop);
    const seen = await validate(shot, [
      "An Automation run receipt is visible with a succeeded status and a desktop execution thread",
      "The receipt identifies a Connect capability call made through the local runtime",
      "No draft, review, permission picker, or crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  await clickButton(desktop, "Deactivate");
  await waitForText(desktop, "Inactive", { timeoutMs: 30_000 });
  await waitFor(
    desktop,
    `document.body.innerText.includes('No future run scheduled') || document.body.innerText.includes('No next run')`,
    { timeoutMs: 30_000, label: "future due time cleared after deactivation" },
  );
  await clickButton(desktop, "Reactivate");
  await waitForText(desktop, "Active", { timeoutMs: 30_000 });
  await waitFor(
    desktop,
    `document.body.innerText.includes('Next run') && !document.body.innerText.includes('No future run scheduled')`,
    { timeoutMs: 30_000, label: "next future occurrence recalculated" },
  );
});
