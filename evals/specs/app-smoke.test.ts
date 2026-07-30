import { expect, test } from "vitest";
import { attachSurface } from "@openwork/cdp";
import { evalIn, waitFor } from "@openwork/behaviors";
import { fraimz } from "@openwork/fraimz";

const cdpUrl = process.env.OPENWORK_EVAL_CDP_URL?.trim() ?? "";
const title = cdpUrl
  ? "app boots with a control route and meaningful visible content"
  : "app smoke skipped: set OPENWORK_EVAL_CDP_URL to attach a running app";

test.skipIf(!cdpUrl)(title, async ({ annotate }) => {
  await using app = await attachSurface({
    name: "running-app",
    kind: "electron",
    hostKind: "attached",
    cdpUrl,
  });
  await waitFor(app, "Boolean(window.__openworkControl)", { timeoutMs: 30_000, label: "window.__openworkControl" });
  const route = await evalIn(app, "window.__openworkControl.snapshot().route");
  expect(route).toBeTruthy();
  await waitFor(app, "document.body.innerText.trim().length > 40", { timeoutMs: 30_000, label: "rendered body text" });
  const frame = fraimz((message, attachment) => annotate(message, typeof attachment === "string" ? attachment : undefined));
  await frame(app, "booted");
});
