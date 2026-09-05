import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { connectorBranding, isRecord } from "../worlds/library.ts";

const test = spec.world(connectorBranding);

test("connector-backed tool calls show first-class branding and human-readable labels", async ({ user, probe }) => {
  await user.see({ text: /Fetched Google Workspace Calendar Events/ }, { timeoutMs: 30_000 });
  await user.notSee({ text: /openwork-cloud_execute_capability/ });
  // TODO(primitive): probe.connectorBranding
  const rendered = await probe.eval(`(() => {
    const mark = document.querySelector('[data-connector-name="Google Workspace"]');
    const row = mark?.closest('[data-capability-call]');
    const image = mark?.querySelector('img');
    return {
      connector: mark?.getAttribute('data-connector-name') ?? null,
      imageLoaded: image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
      text: row instanceof HTMLElement ? row.innerText.replace(/\\s+/g, ' ').trim() : '',
      rawNameVisible: document.body.innerText.includes('openwork-cloud_execute_capability'),
    };
  })()`);
  expect(rendered).toMatchObject({ connector: "Google Workspace", imageLoaded: true, rawNameVisible: false });
  if (!isRecord(rendered) || typeof rendered.text !== "string") throw new Error("The connector row was not readable.");
  expect(rendered.text).toContain("Fetched Google Workspace Calendar Events");
});
