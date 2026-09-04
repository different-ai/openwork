import { expect } from "vitest";
import { chrome } from "@openwork/hosts";
import { evaluateOnSurface } from "@openwork/cdp";
import { eventually, needs, test } from "@openwork/testkit";

test("visitors see consistent monthly Team and Enterprise pricing", async ({ evidence }) => {
  needs({ env: ["OPENWORK_EVAL_LANDING_URL"] });
  const origin = process.env.OPENWORK_EVAL_LANDING_URL;
  await using browser = await chrome({ startUrl: `${origin}/pricing`, headless: true });
  const visible = await eventually(async () => evaluateOnSurface(browser, "document.body.innerText"), {
    within: 30_000,
    until: (value) => typeof value === "string" && value.includes("$10") && value.includes("$40"),
  });
  expect(visible).toContain("$10");
  expect(visible).toContain("$40");
  expect(visible).not.toContain("$20");
  expect(visible).not.toContain("$50");
  evidence.recordAssertionEvidence("Visitors see the new prices in the browser", "Team $10; Enterprise $40; old prices absent", true);
  for (const path of ["/pricing"]) {
    const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(60_000) });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/>\$10<\/span>/);
    expect(html).toMatch(/>\$40<\/span>/);
    expect(html).not.toMatch(/>\$(20|50)<\/span>/);
    expect(html).toContain("per seat / month");
    expect(html).toContain("per user / month");
    evidence.recordAssertionEvidence(`${path} displays the new monthly prices`, "Team $10; Enterprise $40; old card prices absent", true);
    if (path === "/pricing") {
      const scripts = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)];
      const product = scripts.map((match) => JSON.parse(match[1])).find((data) => data["@type"] === "Product");
      expect(product.offers.map((offer: { price: string }) => offer.price)).toEqual(["0", "10", "40"]);
      expect(html).toContain("$10 Team, $40 Enterprise");
      evidence.recordAssertionEvidence("Search metadata agrees with visible pricing", "Free 0, Team 10, Enterprise 40 USD", true);
    }
  }
  const response = await fetch(`${origin}/llms.txt`, { signal: AbortSignal.timeout(10_000) });
  expect(response.status).toBe(200);
  const guide = await response.text();
  expect(guide).toContain("Team — $10 per seat/month");
  expect(guide).toContain("Enterprise — $40 per user/month");
  expect(guide).not.toContain("Team Starter");
  expect(guide).not.toContain("Enterprise — custom");
  evidence.recordAssertionEvidence("The public agent guide agrees with pricing", "Team $10/seat/month and Enterprise $40/user/month", true);
});
