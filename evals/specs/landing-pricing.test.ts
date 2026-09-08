import { expect } from "vitest";
import { chrome } from "@openwork/hosts";
import { evaluateOnSurface, setViewport } from "@openwork/cdp";
import { eventually, needs, test } from "@openwork/testkit";

test("visitors see consistent monthly Team and Enterprise pricing", async ({ evidence }) => {
  needs({ env: ["OPENWORK_EVAL_LANDING_URL"] });
  const origin = process.env.OPENWORK_EVAL_LANDING_URL;
  await using browser = await chrome({ startUrl: `${origin}/pricing`, headless: true });
  const visible = await eventually(async () => evaluateOnSurface(browser, () => (document.body.innerText)), {
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

test("visitors can read the trust badge and access every footer link at responsive widths", async ({ evidence }) => {
  needs({ env: ["OPENWORK_EVAL_LANDING_URL"] });
  const origin = process.env.OPENWORK_EVAL_LANDING_URL;
  await using browser = await chrome({ startUrl: `${origin}/pricing`, headless: true });
  await eventually(() => evaluateOnSurface(browser, () => Boolean(document.querySelector("footer svg"))), {
    within: 30_000,
    until: Boolean,
  });

  for (const width of [320, 768, 1024, 1440]) {
    await setViewport(browser, { width, height: 900, deviceScaleFactor: 1 });
    const facts = await evaluateOnSurface(browser, async () => {
      await document.fonts.ready;
      const footer = document.querySelector("footer");
      const badge = footer?.querySelector('a[aria-label^="SOC 2 Type I"]');
      const icon = badge?.querySelector("svg");
      if (!footer || !badge || !icon) throw new Error("Footer trust badge or shield missing");
      const text = [...badge.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes("SOC 2 Type I"));
      if (!text || !text.textContent) throw new Error("Trust badge text missing");
      const range = document.createRange();
      range.setStart(text, text.textContent.indexOf("SOC 2 Type I"));
      range.setEnd(text, text.textContent.indexOf("SOC 2 Type I") + "SOC 2 Type I".length);
      const lines = [...range.getClientRects()];
      const bounds = footer.getBoundingClientRect();
      const iconBounds = icon.getBoundingClientRect();
      const links = [...footer.querySelectorAll("a")];
      const brand = footer.querySelector('a[href="https://opencode.ai"]');
      const poweredBy = brand?.parentElement?.querySelector("span");
      if (!brand || !poweredBy) throw new Error("Powered by OpenCode missing");
      const brandBounds = brand.getBoundingClientRect();
      const poweredByBounds = poweredBy.getBoundingClientRect();
      const badgeBounds = badge.getBoundingClientRect();
      const linksBottom = Math.max(...links.filter((link) => link !== brand && link !== badge)
        .map((link) => link.getBoundingClientRect().bottom));
      return {
        viewport: window.innerWidth,
        lines: lines.length,
        textVisible: lines.every((rect) => rect.width > 0 && rect.height > 0),
        iconWidth: iconBounds.width,
        iconHeight: iconBounds.height,
        poweredBy: poweredBy.textContent,
        brandInline: poweredByBounds.right <= brandBounds.left
          && poweredByBounds.top < brandBounds.bottom && brandBounds.top < poweredByBounds.bottom,
        brandRowBelowLinks: Math.min(poweredByBounds.top, brandBounds.top, badgeBounds.top) >= linksBottom,
        badgeBesideBrand: badgeBounds.left >= brandBounds.right
          && badgeBounds.top < brandBounds.bottom && brandBounds.top < badgeBounds.bottom,
        footerFits: bounds.left >= 0 && bounds.right <= window.innerWidth && footer.scrollWidth <= footer.clientWidth,
        contentFits: [...footer.querySelectorAll("*")].every((element) => {
          const rect = element.getBoundingClientRect();
          return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
        }),
        links: links.map((link) => [link.getAttribute("href"), link.getAttribute("aria-label") ?? link.textContent.trim()]),
        linksVisible: links.every((link) => {
          const rect = link.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(link).visibility === "visible";
        }),
      };
    });
    expect(facts, `footer at ${width}px`).toMatchObject({
      viewport: width, lines: 1, textVisible: true, iconWidth: 14, iconHeight: 14,
      footerFits: true, contentFits: true, linksVisible: true,
      poweredBy: "Powered by", brandInline: true, brandRowBelowLinks: true,
    });
    if (width >= 768) expect(facts.badgeBesideBrand, `trust badge beside brand at ${width}px`).toBe(true);
    expect(facts.links).toEqual([
      ["/docs", "Docs"], ["/pricing", "Pricing"], ["/roadmap", "Roadmap"],
      ["/download", "Desktop"], ["https://app.openworklabs.com", "Cloud"],
      ["/dashboard", "Dashboard"], ["/enterprise", "Enterprise"], ["/contact", "Contact"],
      ["/trust", "Trust Center"], ["/privacy", "Privacy"], ["/terms", "Terms"],
      ["https://opencode.ai", ""], ["/trust", "SOC 2 Type I — view Trust Center"],
    ]);
    evidence.recordAssertionEvidence(`Footer remains readable and complete at ${width}px`, JSON.stringify(facts), true);
  }
});
