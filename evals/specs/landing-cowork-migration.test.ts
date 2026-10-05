import { expect } from "vitest";
import { chrome } from "@openwork/hosts";
import { evaluateOnSurface } from "@openwork/cdp";
import { eventually, needs, test } from "@openwork/testkit";

const PROMPT = "Follow https://openworklabs.com/migrate.md to move my Claude plugins and skills to OpenWork.";

// People leaving Claude Cowork land on the migration guide from the homepage.
// It used to describe a plugin import the app no longer has and send them to
// other guides that point back to it, without ever giving them a step to take.
test("a person leaving Claude Cowork finds one prompt to paste, and the guide their agent follows", async ({ evidence }) => {
  needs({ env: ["OPENWORK_EVAL_LANDING_URL"] });
  const origin = process.env.OPENWORK_EVAL_LANDING_URL;
  const page = `${origin}/docs/start-here/migrate-from-claude-cowork`;
  await using browser = await chrome({ startUrl: page, headless: true });

  const visible = await eventually(async () => evaluateOnSurface(browser, () => document.body.innerText), {
    within: 30_000,
    until: (value) => typeof value === "string" && value.includes("Migration guide"),
  });
  const text = String(visible);
  evidence.recordAssertionEvidence(
    "The page leads with the prompt",
    text.includes(PROMPT) ? `shows: "${PROMPT}"` : `prompt missing; page starts: ${text.slice(0, 200)}`,
    text.includes(PROMPT),
  );
  expect(text).toContain(PROMPT);

  evidence.recordAssertionEvidence(
    "It no longer describes the removed plugin import",
    text.includes("Import the manifest") ? "still says \"Import the manifest\"" : "no \"Import the manifest\" or \"install the plugin\" wording",
    !text.includes("Import the manifest"),
  );
  expect(text).not.toContain("Import the manifest");
  expect(text).not.toContain("install the plugin that contains it");

  const link = await evaluateOnSurface(browser, () => document.querySelector('a[href="/migrate.md"]')?.textContent ?? null);
  const guide = await fetch(`${origin}/migrate.md`, { signal: AbortSignal.timeout(30_000) });
  const guideText = await guide.text();
  evidence.recordAssertionEvidence(
    "The agent guide it links to is served",
    `link "${String(link)}" → /migrate.md ${guide.status}; mentions migrate apply: ${guideText.includes("openwork-bootstrap migrate apply")}`,
    guide.status === 200 && Boolean(link),
  );
  expect(link).toBeTruthy();
  expect(guide.status).toBe(200);
  expect(guideText).toContain("openwork-bootstrap migrate apply");

  const llms = await (await fetch(`${origin}/llms.txt`, { signal: AbortSignal.timeout(10_000) })).text();
  evidence.recordAssertionEvidence("Agents reading llms.txt are pointed at migrate.md", llms.includes("https://openworklabs.com/migrate.md") ? "llms.txt links migrate.md" : "missing", llms.includes("https://openworklabs.com/migrate.md"));
  expect(llms).toContain("https://openworklabs.com/migrate.md");
});
