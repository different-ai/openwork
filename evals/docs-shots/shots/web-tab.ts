import { waitFor } from "@openwork/behaviors";
import { org } from "../seed.ts";
import { webTab } from "../surfaces.ts";
import { shot } from "./shot.ts";

const browser = webTab({ org });

async function waitForOpenWorkWeb(surface: Awaited<ReturnType<typeof browser.load>>): Promise<void> {
  await waitFor(surface, "Boolean(window.__openworkControl)", {
    timeoutMs: 120_000,
    label: "OpenWork Web booted",
  });
  await waitFor(surface, `document.body.innerText.includes("acme-robotics")
    && document.body.innerText.includes("Describe your task")
    && !document.body.innerText.includes("Pulling in the latest messages")`, {
    timeoutMs: 120_000,
    label: "OpenWork Web settled on the demo workspace",
  });
}

export const openworkWebTab = shot("openwork-web-tab", {
  use: browser,
  at: "/",
  steps: [waitForOpenWorkWeb],
  expect: ["acme-robotics", "What do you need done?"],
  never: ["Something went wrong", "Unable to connect", "docs-3959-screenshots"],
  out: "packages/docs/images/openwork-web-browser-tab.png",
});
