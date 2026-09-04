import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { sessionErrorCard } from "../worlds/chat.ts";

const test = spec.world(sessionErrorCard);

// Values from the seeded payload (eval.session_error.seed): an Anthropic 429
// with a JSON response body. None of these appear in the plain card text.
const CARD_TEXT = "Rate limit reached for claude-sonnet-4-5";
const DIAGNOSTIC_LINES = ["Error type: APIError", "Status: 429", "Provider: anthropic", "Code: rate_limit_error", "Retries: 3"];
const REQUEST_ID = "req_01JZK4W9N7X2Q8M3V5T6B1C0DE";
// Rendered with CSS uppercase, so compare case-insensitively.
const DEBUG_PANEL_TITLE = /react session debug/i;

const detailsToggle = { testId: "session-error-details-toggle" };
const detailsPanel = { testId: "session-error-details" };
const statusLine = { text: /Status: 429/ };
const requestId = { text: new RegExp(REQUEST_ID) };

test("session error cards expose provider diagnostics only in Developer mode", async ({ user, probe, step, world, place }) => {
  // Toggle Developer mode the way a person does: command palette → "Enable/Disable Developer Mode".
  const toggleDeveloperMode = async (next: "on" | "off") => {
    const label = next === "on" ? /enable developer mode/i : /disable developer mode/i;
    await user.press(place.kind !== "daytona" && process.platform === "darwin" ? "Meta+K" : "Control+K");
    await user.click({ role: "option", label });
    await probe.eventually(() => probe.storage("openwork.developerMode"), {
      until: (value) => String(value) === (next === "on" ? "1" : "0"),
      within: 10_000,
      label: `Developer mode persisted ${next}`,
    });
  };

  await step("with Developer mode off, a failed turn shows only the plain error card", async () => {
    await user.see({ text: new RegExp(CARD_TEXT) });
    expect(String(await probe.storage("openwork.developerMode"))).not.toBe("1");
    await user.notSee(detailsToggle);
    await user.notSee(statusLine);
    await user.notSee(requestId);
    await user.notSee({ text: DEBUG_PANEL_TITLE });
  });

  await step("enabling Developer mode reaches the session surface without a reload", async () => {
    await toggleDeveloperMode("on");
    await user.see(detailsToggle);
    await user.see({ text: new RegExp(CARD_TEXT) });
    await user.see({ text: DEBUG_PANEL_TITLE });
    // The disclosure starts collapsed: the toggle is present, the panel is not.
    await user.notSee(detailsPanel);
    await user.notSee(statusLine);
  });

  await step("opening Technical details shows the full provider diagnostic payload with a copy action", async () => {
    await user.click(detailsToggle);
    await user.see(detailsPanel);
    for (const line of DIAGNOSTIC_LINES) await user.see({ text: new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    // The request id sits inside the raw response-body block, so match it within that block's text.
    await user.see(requestId);
    await user.see({ role: "button", label: /copy details/i });
  });

  await step("disabling Developer mode removes diagnostics while the error card remains", async () => {
    await toggleDeveloperMode("off");
    await user.notSee(detailsToggle, { timeoutMs: 10_000 });
    await user.see({ text: new RegExp(CARD_TEXT) });
    await user.notSee(detailsPanel);
    await user.notSee(statusLine);
    await user.notSee(requestId);
    await user.notSee({ text: DEBUG_PANEL_TITLE });
  });

  const storageErrors: Array<"disk-full" | "database-error"> = ["disk-full", "database-error"];
  for (const kind of storageErrors) {
    await step(`${kind} shows recovery guidance and keeps the stack trace in Developer mode`, async () => {
      await world.seedStorageError(kind);
      const title = kind === "disk-full" ? "Not enough disk space" : "OpenWork couldn’t access its saved data";
      await user.see({ text: title });
      await user.see({ text: kind === "disk-full" ? /Free up some disk space/ : /check the available disk space/ });
      await user.notSee({ text: /effect\/sql\/SqlError/ });
      await user.notSee({ text: /at runLoop/ });
      await user.notSee(detailsToggle);
      if (kind === "database-error") await user.notSee({ text: "Not enough disk space" });
      await toggleDeveloperMode("on");
      await user.click(detailsToggle);
      await user.see({ text: /effect\/sql\/SqlError/ });
      await user.see({ text: /at runLoop/ });
      await user.see({ role: "button", label: /copy details/i });
      await toggleDeveloperMode("off");
      await user.see({ text: title });
      await user.notSee(detailsPanel);
      await user.notSee({ text: /at runLoop/ });
    });
    await step(`${kind} banner hides the stack trace outside Developer mode`, async () => {
      await world.seedStorageError(kind, "banner");
      const title = kind === "disk-full" ? "Not enough disk space" : "OpenWork couldn’t access its saved data";
      await user.see({ testId: "session-error-card" });
      await user.see({ text: title });
      await user.notSee({ text: /at runLoop/ });
      await toggleDeveloperMode("on");
      await user.see({ text: /effect\/sql\/SqlError/ });
      await user.see({ text: /at runLoop/ });
      await toggleDeveloperMode("off");
      await user.see({ text: title });
      await user.notSee({ text: /at runLoop/ });
    });
  }

});
