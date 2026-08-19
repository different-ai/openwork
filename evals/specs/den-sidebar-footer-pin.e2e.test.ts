import { expect } from "vitest";
import { evalIn, waitFor } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import { needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `den sidebar footer pin skipped — needs: ${missingRequirements.join(", ")}`
  : "expanded Settings keeps the workspace switcher in view while only the sidebar nav scrolls";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface SidebarPinLayout {
  found: boolean;
  viewportHeight: number;
  navScrollHeight: number;
  navClientHeight: number;
  navOverflowY: string;
  asideScrollTop: number;
  asideClientHeight: number;
  asideScrollHeight: number;
  footerTop: number;
  footerBottom: number;
  footerHeight: number;
  hasScim: boolean;
}

function parseLayout(value: unknown): SidebarPinLayout {
  if (!isRecord(value) || value.found !== true) {
    throw new Error(`Sidebar pin layout was not found: ${JSON.stringify(value)}`);
  }
  const layout = {
    found: true,
    viewportHeight: value.viewportHeight,
    navScrollHeight: value.navScrollHeight,
    navClientHeight: value.navClientHeight,
    navOverflowY: value.navOverflowY,
    asideScrollTop: value.asideScrollTop,
    asideClientHeight: value.asideClientHeight,
    asideScrollHeight: value.asideScrollHeight,
    footerTop: value.footerTop,
    footerBottom: value.footerBottom,
    footerHeight: value.footerHeight,
    hasScim: value.hasScim,
  };
  if (
    typeof layout.viewportHeight !== "number"
    || typeof layout.navScrollHeight !== "number"
    || typeof layout.navClientHeight !== "number"
    || typeof layout.navOverflowY !== "string"
    || typeof layout.asideScrollTop !== "number"
    || typeof layout.asideClientHeight !== "number"
    || typeof layout.asideScrollHeight !== "number"
    || typeof layout.footerTop !== "number"
    || typeof layout.footerBottom !== "number"
    || typeof layout.footerHeight !== "number"
    || typeof layout.hasScim !== "boolean"
  ) {
    throw new Error(`Sidebar pin layout had an unexpected shape: ${JSON.stringify(value)}`);
  }
  return layout;
}

const readLayout = `(() => {
  const nav = document.querySelector('[data-testid="den-org-sidebar"]');
  const footer = document.querySelector('[data-testid="den-org-sidebar-footer"]');
  const aside = nav?.closest("aside");
  if (!(nav instanceof HTMLElement) || !(footer instanceof HTMLElement) || !(aside instanceof HTMLElement)) {
    return { found: false };
  }
  const footerRect = footer.getBoundingClientRect();
  return {
    found: true,
    viewportHeight: window.innerHeight,
    navScrollHeight: nav.scrollHeight,
    navClientHeight: nav.clientHeight,
    navOverflowY: getComputedStyle(nav).overflowY,
    asideScrollTop: aside.scrollTop,
    asideClientHeight: aside.clientHeight,
    asideScrollHeight: aside.scrollHeight,
    footerTop: footerRect.top,
    footerBottom: footerRect.bottom,
    footerHeight: footerRect.height,
    hasScim: [...nav.querySelectorAll("a")].some((link) => (link.textContent ?? "").includes("SCIM")),
  };
})()`;

test(title, async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({
    place,
    org: {
      name: `Den Sidebar Footer Pin ${Date.now()}`,
      admin: { name: "Sarah" },
    },
  });

  await using browser = await chrome({
    name: "den-sidebar-footer-pin",
    startUrl: den.ref.webUrl,
    headless: true,
    host: place.host(),
  });
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web origin before admin auth token handoff",
  });

  const adminTokenStored = await evalIn(browser, `(() => {
    localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(den.admin.token)});
    return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(den.admin.token)};
  })()`);
  expect(adminTokenStored).toBe(true);
  await navigate(browser.client, `${den.ref.webUrl}/dashboard/org-settings`);
  await waitFor(browser, `Boolean(document.querySelector('[data-testid="den-org-sidebar-footer"]'))
    && [...document.querySelectorAll('[data-testid="den-org-sidebar"] a')].some((link) => (link.textContent ?? "").includes("SCIM"))`, {
    timeoutMs: 60_000,
    label: "expanded Settings with pinned workspace switcher",
  });

  const layout = parseLayout(await evalIn(browser, readLayout));
  const footerInView = layout.footerTop >= 0 && layout.footerBottom <= layout.viewportHeight;
  const navIsScroller = layout.navScrollHeight > layout.navClientHeight + 8
    && (layout.navOverflowY === "auto" || layout.navOverflowY === "scroll");
  const asideDidNotSwallowFooter = layout.asideScrollTop === 0
    && layout.asideScrollHeight <= layout.asideClientHeight + 1;

  expect(layout.hasScim).toBe(true);
  expect(footerInView).toBe(true);
  expect(navIsScroller).toBe(true);
  expect(asideDidNotSwallowFooter).toBe(true);
  evidence.recordAssertionEvidence(
    "Expanded Settings keeps the workspace switcher in the viewport while only the sidebar nav scrolls",
    JSON.stringify(layout),
    footerInView && navIsScroller && asideDidNotSwallowFooter && layout.hasScim,
  );
});
