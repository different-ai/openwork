import type { Seed } from "@openwork/env";

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export async function adminDashboardWeb(seed: Seed) {
  const den = await seed.den({
    org: { name: `Admin navigation ${Date.now()}`, admin: { name: "Navigation Admin" } },
  });
  const web = await seed.web({
    den,
    signedInAs: den.admin,
    startPath: "/dashboard",
    headless: true,
    viewport: { width: 1440, height: 1100 },
  });
  return {
    den,
    web,
    /** The current web location's pathname and search. */
    // TODO(primitive): probe.location should expose pathname+search on web surfaces; probe.hash only covers the hash.
    async location(): Promise<string> {
      const value = await seed.evalIn(web, "window.location.pathname + window.location.search");
      if (typeof value !== "string") throw new Error("Expected the web location to be a string.");
      return value;
    },
    /** The accessible link names in the organization sidebar. */
    // TODO(primitive): probe should list accessible link names inside a container by testId.
    async sidebarLinks(): Promise<string[]> {
      return strings(await seed.evalIn(web, "Array.from(document.querySelectorAll('[data-testid=\"den-org-sidebar\"] a')).map((a) => (a.textContent ?? '').trim())"));
    },
    /** The direct text labels of selected tabs. */
    // TODO(primitive): user.see({ role: "tab" }) cannot assert aria-selected today.
    async selectedTabs(): Promise<string[]> {
      return strings(await seed.evalIn(web, "Array.from(document.querySelectorAll('[role=\"tab\"][aria-selected=\"true\"]')).map((tab) => Array.from(tab.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? '').join('').trim())"));
    },
  };
}
