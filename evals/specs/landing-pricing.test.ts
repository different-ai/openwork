import { expect } from "vitest";
import { chrome } from "@openwork/hosts";
import { clickAt, evaluateOnSurface, locate, navigate, reload, setViewport } from "@openwork/cdp";
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

  await navigate(browser.client, `${origin}/enterprise`);
  const hero = await eventually(() => evaluateOnSurface(browser, () => {
    const section = document.querySelector<HTMLElement>("main > section");
    if (!section) throw new Error("Enterprise hero missing");
    return section.innerText;
  }), {
    within: 30_000,
    until: (text) => typeof text === "string" && text.includes("OpenWork Enterprise"),
  });
  expect(hero).not.toContain("SOC 2 Type II");
  for (const badge of ["SOC 2 Type I", "SAML SSO + SCIM", "Audit logs", "Self-host or managed", "White labeling"]) {
    expect(hero).toContain(badge);
  }
  evidence.recordAssertionEvidence("Enterprise hero omits the in-progress Type II badge and retains the other badges", hero, true);
});

test("download CTAs request the detected installer once and retain the alternative downloads", async ({ evidence }) => {
  needs({ env: ["OPENWORK_EVAL_LANDING_URL"] });
  const origin = process.env.OPENWORK_EVAL_LANDING_URL;
  await using browser = await chrome({ startUrl: "about:blank", headless: true });
  const version = await (await fetch(`${browser.handle.cdpUrl}/json/version`, { signal: AbortSignal.timeout(10_000) })).json();
  const socketUrl = new URL(version.webSocketDebuggerUrl);
  const cdpBase = new URL(browser.handle.cdpUrl);
  socketUrl.protocol = cdpBase.protocol === "https:" ? "wss:" : "ws:";
  socketUrl.host = cdpBase.host;
  const socket = new WebSocket(socketUrl);
  const requests: string[] = [];
  const errors: string[] = [];
  let ready = false;
  let commandId = 1;
  const enabling = new Map<number, { sessionId: string; primary: boolean }>();
  socket.onopen = () => socket.send(JSON.stringify({
    id: commandId,
    method: "Target.setAutoAttach",
    params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }
  }));
  socket.onerror = () => errors.push("Download witness socket failed");
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.error) errors.push(JSON.stringify(message.error));
    if (message.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo } = message.params;
      const id = ++commandId;
      enabling.set(id, { sessionId, primary: targetInfo.targetId === browser.client.targetId });
      // Include cross-origin frames and alternate links opened in a new tab.
      socket.send(JSON.stringify({ id, sessionId, method: "Fetch.enable", params: {
        patterns: [{ urlPattern: "https://github.com/different-ai/openwork/releases*", requestStage: "Request" }]
      } }));
      return;
    }
    const enabled = enabling.get(message.id);
    if (enabled) {
      enabling.delete(message.id);
      socket.send(JSON.stringify({ id: ++commandId, sessionId: enabled.sessionId, method: "Target.setAutoAttach",
        params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } }));
      socket.send(JSON.stringify({ id: ++commandId, sessionId: enabled.sessionId, method: "Runtime.runIfWaitingForDebugger" }));
      if (enabled.primary && !message.error) ready = true;
    }
    if (message.method !== "Fetch.requestPaused") return;
    requests.push(message.params.request.url);
    // Witness the real browser request without downloading a release binary or
    // contacting GitHub. Release-page mistakes are captured by the same pattern.
    socket.send(JSON.stringify({
      id: ++commandId,
      sessionId: message.sessionId,
      method: "Fetch.fulfillRequest",
      params: {
        requestId: message.params.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "Content-Type", value: "application/octet-stream" },
          { name: "Content-Disposition", value: "attachment; filename=installer-fixture" }
        ],
        body: ""
      }
    }));
  };

  try {
    await eventually(() => ready, { within: 10_000, until: Boolean });
    await browser.client.send("Browser.setDownloadBehavior", { behavior: "deny" });
    await browser.client.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const devices = [
      { platform: "macOS", ua: "Macintosh; Intel Mac OS X 10_15_7", architecture: "arm", asset: /mac-(arm64|universal).*\.dmg$/i },
      { platform: "macOS", ua: "Macintosh; Intel Mac OS X 10_15_7", architecture: "x86", asset: /mac-(x64|universal).*\.dmg$/i },
      { platform: "Windows", ua: "Windows NT 10.0; Win64; x64", architecture: "x86", asset: /win-x64.*\.exe$/i },
      { platform: "Windows", ua: "Windows NT 10.0; Win64; x64", architecture: "arm", asset: /win-arm64.*\.exe$/i },
      { platform: "Linux", ua: "X11; Linux x86_64", architecture: "x86", asset: /linux-(x86_64|x64).*\.(AppImage|tar\.gz)$/i },
      { platform: "Linux", ua: "X11; Linux aarch64", architecture: "arm", asset: /linux-arm64.*\.(AppImage|tar\.gz)$/i },
      { platform: "Unknown", ua: "Unknown desktop", architecture: "x86", asset: null },
      { platform: "Chrome OS", ua: "X11; CrOS x86_64", architecture: "x86", asset: null },
      { platform: "Android", ua: "Linux; Android 14; Mobile", architecture: "arm", asset: null }
    ];
    const attribution = "?utm_source=download-journey&utm_campaign=onboarding";
    let supportedDownloads = 0;
    for (const device of devices) {
      await browser.client.send("Emulation.setUserAgentOverride", {
        userAgent: `Mozilla/5.0 (${device.ua}) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36`,
        userAgentMetadata: {
          brands: [{ brand: "Chromium", version: "130" }],
          fullVersionList: [{ brand: "Chromium", version: "130.0.0.0" }],
          platform: device.platform, platformVersion: "15.0.0", architecture: device.architecture,
          bitness: "64", model: "", mobile: device.platform === "Android"
        }
      });
      const before = requests.length;
      await navigate(browser.client, `${origin}/download${attribution}`);
      await eventually(() => evaluateOnSurface(browser, () => Boolean(document.querySelector('[data-testid="download-openwork-card"][data-detection-source]'))), {
        within: 30_000, until: Boolean
      });
      const alternatives = await evaluateOnSurface(browser, () => Array.from(document.querySelectorAll<HTMLAnchorElement>('[data-download-openwork-link]'), (link) => ({
        label: link.textContent?.trim(), href: link.href, target: link.target
      })));
      expect(alternatives).toHaveLength(8);
      expect(alternatives.every((link) => link.target === "_blank")).toBe(true);
      const expected = device.asset ? alternatives.find((link) => device.asset?.test(link.href))?.href : undefined;
      // Observe beyond the bounded detection wait, not just the first render.
      await new Promise((resolve) => setTimeout(resolve, 1700));
      expect(requests).toHaveLength(before);

      // Carry a campaign through the actual homepage CTA (not a crafted intent URL).
      await navigate(browser.client, `${origin}/${attribution}`);
      await eventually(() => evaluateOnSurface(browser, () => document.body.innerText.includes("Contact sales")), { within: 30_000, until: Boolean });
      expect(requests).toHaveLength(before);
      await clickAt(browser, (await locate(browser, { role: "link", text: device.platform === "Android" ? /^Download$/ : /^Download for free/ })).center);
      await eventually(() => evaluateOnSurface(browser, () => location.pathname + location.search), {
        within: 30_000, until: (path) => path === `/download${attribution}`
      });
      if (expected) {
        await eventually(() => requests.length, { within: 10_000, until: (count) => count > before });
        expect(requests.slice(before)).toEqual([expected]);
        supportedDownloads += 1;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1700));
        expect(requests).toHaveLength(before);
      }
      const afterClick = requests.length;
      await reload(browser);
      await eventually(() => evaluateOnSurface(browser, () => Boolean(document.querySelector('[data-testid="download-openwork-card"][data-detection-source]'))), {
        within: 30_000, until: Boolean
      });
      await new Promise((resolve) => setTimeout(resolve, 1700));
      expect(requests).toHaveLength(afterClick);
      expect(await evaluateOnSurface(browser, () => Array.from(document.querySelectorAll<HTMLAnchorElement>('[data-download-openwork-link]'), (link) => ({
        label: link.textContent?.trim(), href: link.href, target: link.target
      })))).toEqual(alternatives);
      if (device.platform === "Windows" && device.architecture === "x86" && expected) {
        await clickAt(browser, (await locate(browser, { role: "link", text: /^Download$/ })).center);
        await eventually(() => requests.length, { within: 10_000, until: (count) => count > afterClick });
        expect(requests.slice(afterClick)).toEqual([expected]);
        const alternate = alternatives.find((link) => /mac-(arm64|universal).*\.dmg$/i.test(link.href));
        expect(alternate).toBeDefined();
        const beforeAlternate = requests.length;
        await clickAt(browser, (await locate(browser, { role: "link", text: /^Apple Silicon/ })).center);
        await eventually(() => requests.length, { within: 10_000, until: (count) => count > beforeAlternate });
        expect(requests.slice(beforeAlternate)).toEqual([alternate?.href]);
        expect(await evaluateOnSurface(browser, () => location.pathname)).toBe("/download");
      }
      evidence.recordAssertionEvidence(`${device.platform} ${device.architecture}: click-only download with manual alternatives`,
        expected ? "Exactly the matching installer requested; attribution and 8 alternatives retained; visiting and reloading do not download"
          : "Unknown platform or missing installer requests nothing; all 8 manual alternatives retained", true);
    }
    expect(supportedDownloads).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    socket.close();
  }
});
