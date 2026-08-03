import { expect, onTestFinished, test } from "vitest";
import { chrome } from "@openwork/hosts";
import { photoRoll, screenshot, validate } from "@openwork/fraimz";
import {
  createMarketplace,
  denFetch,
  evalIn,
  fill,
  signIn,
  signInInBrowser,
  waitFor,
  waitForText,
} from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";

/**
 * CORE JOURNEY: an org admin opens the cloud dashboard's marketplace catalogue
 * and can actually read it: every entry carries its own identity, the counts
 * line up in one comparable column, empty catalogues read as quiet zeros,
 * readiness only speaks when a plugin needs action, and the plugin detail opens
 * with the identity the person clicked.
 *
 * Faithfulness notes:
 *  - This is a real den-web page in a real Chrome; the seeded demo catalogue is
 *    the data.
 *  - The one empty marketplace is created through the product's own API and
 *    cleaned up after the test.
 *  - The readiness-parity assertion uses the resolved-marketplace API as the
 *    authority for what "needs action".
 */

const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const denApiUrl = process.env.OPENWORK_EVAL_DEN_API_URL?.trim().replace(/\/+$/, "") ?? "";
const denWebUrl = (process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim() || denApiUrl.replace("127.0.0.1", "localhost")).replace(/\/+$/, "");
const email = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const password = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";

const title = !appSpecsEnabled
  ? "marketplace catalogue legibility skipped: set OPENWORK_EVAL_APP_SPECS=1 to opt in"
  : !denApiUrl
    ? "marketplace catalogue legibility skipped: set OPENWORK_EVAL_DEN_API_URL to a running Den"
    : "an org admin can read identity, counts, and exceptional readiness across the cloud catalogues";

type Marketplace = { id: string; name: string; pluginCount: number };
type CatalogRow = { title: string; value: string; muted: boolean; badge: string; right: number };
type PluginHeader = { tile: string; title: string; meta: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMarketplace(value: unknown): Marketplace | null {
  if (
    !isRecord(value)
    || typeof value.id !== "string"
    || typeof value.name !== "string"
    || typeof value.pluginCount !== "number"
  ) return null;
  return { id: value.id, name: value.name, pluginCount: value.pluginCount };
}

function parseMarketplaces(value: unknown): Marketplace[] {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error(`Marketplace list had an unexpected shape: ${JSON.stringify(value).slice(0, 300)}`);
  }
  return value.items.flatMap((item) => {
    const marketplace = parseMarketplace(item);
    return marketplace ? [marketplace] : [];
  });
}

function countNeedsAction(value: unknown): number {
  const item = isRecord(value) && isRecord(value.item) ? value.item : isRecord(value) ? value : null;
  if (!item || !Array.isArray(item.plugins)) {
    throw new Error(`Resolved marketplace had an unexpected shape: ${JSON.stringify(value).slice(0, 300)}`);
  }
  return item.plugins.filter((plugin) => {
    const readiness = isRecord(plugin) && isRecord(plugin.cloudReadiness) ? plugin.cloudReadiness : null;
    const state = readiness && typeof readiness.state === "string" ? readiness.state : "unknown";
    return state !== "ready" && state !== "desktop_only" && state !== "unknown";
  }).length;
}

function parseRows(value: unknown): CatalogRow[] {
  if (!Array.isArray(value) || !value.every((row) => (
    isRecord(row)
    && typeof row.title === "string"
    && typeof row.value === "string"
    && typeof row.muted === "boolean"
    && typeof row.badge === "string"
    && typeof row.right === "number"
  ))) throw new Error(`Catalogue rows had an unexpected shape: ${JSON.stringify(value).slice(0, 300)}`);
  return value;
}

function parseStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${label} had an unexpected shape: ${JSON.stringify(value).slice(0, 300)}`);
  }
  return value;
}

function parsePluginHeader(value: unknown): PluginHeader {
  if (
    !isRecord(value)
    || typeof value.tile !== "string"
    || typeof value.title !== "string"
    || typeof value.meta !== "string"
  ) throw new Error(`Plugin header had an unexpected shape: ${JSON.stringify(value).slice(0, 300)}`);
  return { tile: value.tile, title: value.title, meta: value.meta };
}

async function listMarketplaces(admin: DenSession): Promise<Marketplace[]> {
  const result = await denFetch(admin, "/v1/marketplaces?status=active&limit=100", {
    headers: { authorization: `Bearer ${admin.token}` },
  });
  if (!result.response.ok) {
    throw new Error(`Listing marketplaces failed (${result.response.status}): ${result.text.slice(0, 300)}`);
  }
  return parseMarketplaces(result.body);
}

async function deleteMarketplace(admin: DenSession, id: string): Promise<void> {
  const result = await denFetch(admin, `/v1/marketplaces/${encodeURIComponent(id)}/delete`, {
    method: "POST",
    headers: { authorization: `Bearer ${admin.token}` },
  });
  if (!result.response.ok) {
    throw new Error(`Deleting marketplace ${id} failed (${result.response.status}): ${result.text.slice(0, 300)}`);
  }
}

async function navigate(browser: Surface, baseUrl: string, path: string): Promise<void> {
  const url = new URL(path, baseUrl).toString();
  await evalIn(browser, `location.assign(${JSON.stringify(url)})`);
  await waitFor(browser, `document.readyState === "complete" && location.pathname === ${JSON.stringify(path)}`, {
    timeoutMs: 30_000,
    label: `loaded ${path}`,
  });
}

async function readRows(browser: Surface): Promise<CatalogRow[]> {
  const value = await evalIn(browser, `(() => {
    const list = document.querySelector('[data-testid="catalog-list"]');
    if (!list) return null;
    return [...list.querySelectorAll('[data-testid="catalog-row"]')].map((row) => ({
      title: row.querySelector('[data-testid="catalog-row-title"]')?.textContent?.trim() ?? "",
      value: row.querySelector('[data-testid="catalog-row-value"]')?.textContent?.trim() ?? "",
      muted: row.querySelector('[data-testid="catalog-row-value"]')?.dataset.muted === "true",
      badge: row.querySelector('[data-testid="catalog-row-badge"]')?.textContent?.trim() ?? "",
      right: Math.round(row.querySelector('[data-testid="catalog-row-value"]')?.getBoundingClientRect().right ?? 0),
    }));
  })()`);
  return parseRows(value);
}

test.skipIf(!appSpecsEnabled || !denApiUrl)(title, async () => {
  const den = { apiUrl: denApiUrl, webUrl: denWebUrl };
  const admin = await signIn(den, { email, password });

  for (const marketplace of await listMarketplaces(admin)) {
    if (marketplace.name.startsWith("Spec Empty Catalog")) {
      await deleteMarketplace(admin, marketplace.id);
    }
  }

  const emptyMarketplace = await createMarketplace(admin, { name: `Spec Empty Catalog ${Date.now()}` });
  onTestFinished(async () => deleteMarketplace(admin, emptyMarketplace.id));

  const marketplaces = await listMarketplaces(admin);
  const populated = [...marketplaces].sort((a, b) => b.pluginCount - a.pluginCount)[0];
  expect(populated, "No marketplaces were returned after creating the empty catalogue.").toBeDefined();
  if (!populated) throw new Error("No marketplaces were returned after creating the empty catalogue.");
  expect(
    populated.pluginCount > 0,
    "The demo has no populated marketplace. Seed it with `pnpm dev:den:seed-demo`.",
  ).toBe(true);

  const resolved = await denFetch(admin, `/v1/marketplaces/${encodeURIComponent(populated.id)}/resolved`, {
    headers: { authorization: `Bearer ${admin.token}` },
  });
  if (!resolved.response.ok) {
    throw new Error(`Reading resolved marketplace failed (${resolved.response.status}): ${resolved.text.slice(0, 300)}`);
  }
  const needsAction = countNeedsAction(resolved.body);

  await using browser = await chrome({ name: "marketplace-catalog", startUrl: "about:blank" });
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await signInInBrowser(browser, `${den.webUrl}/dashboard`, { email, password });
  await using roll = photoRoll("marketplace-catalog-legibility");

  await navigate(browser, den.webUrl, "/dashboard/marketplaces");
  await waitForText(browser, "Marketplaces", { timeoutMs: 30_000 });
  await waitFor(browser, `Boolean(document.querySelector('[data-testid="catalog-row"]'))`, {
    timeoutMs: 20_000,
    label: "marketplace catalogue rows",
  });
  {
    const rows = await readRows(browser);
    expect(rows.length > 1, `Expected a divided marketplace list, saw ${rows.length} row(s).`).toBe(true);
    const identityCount = await evalIn(browser, `document.querySelectorAll('[data-testid="catalog-identity-tile"]').length`);
    expect(identityCount, "Every marketplace row should carry its own identity tile.").toBe(rows.length);
    const rightEdges = new Set(rows.map((row) => row.right));
    expect([...rightEdges], "Every plugin count should share one right edge.").toHaveLength(1);
    const counts = rows.map((row) => Number(row.value));
    expect(
      counts.every((count, index) => index === 0 || counts[index - 1] >= count),
      `Stocked catalogues should lead the list. Saw: ${rows.map((row) => `${row.title}: ${row.value}`).join(" | ")}`,
    ).toBe(true);
    await sleep(500);
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "Marketplaces appear as a single divided list rather than a grid of cards",
      "Every marketplace row has a logo or letter identity tile on the left",
      "Plugin counts form one right-aligned column",
      "No 'Something went wrong' or error banner is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  await fill(browser, 'input[type="search"]', emptyMarketplace.name);
  await waitFor(browser, `document.querySelectorAll('[data-testid="catalog-row"]').length === 1`, {
    timeoutMs: 15_000,
    label: "filtered to the empty marketplace",
  });
  {
    const rows = await readRows(browser);
    const row = rows[0];
    expect(row?.title, "Search should narrow the list to the empty marketplace.").toBe(emptyMarketplace.name);
    expect(row?.value, "The empty marketplace should show a zero count.").toBe("0");
    expect(row?.muted, "The empty marketplace zero should be dimmed.").toBe(true);
    await sleep(500);
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "A single marketplace row is visible with a greyed zero count",
      "The zero sits in the same right-aligned count column",
      "No 'Something went wrong' or error banner is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  const marketplacePath = `/dashboard/marketplaces/${encodeURIComponent(populated.id)}`;
  await navigate(browser, den.webUrl, marketplacePath);
  await waitForText(browser, populated.name, { timeoutMs: 30_000 });
  await waitFor(browser, `Boolean(document.querySelector('[data-testid="catalog-row"]'))`, {
    timeoutMs: 20_000,
    label: "marketplace plugin rows",
  });
  {
    const rows = await readRows(browser);
    expect(
      rows.length,
      "Every plugin the API reports for this marketplace should render as a row.",
    ).toBe(populated.pluginCount);
    expect(rows.every((row) => /^\d+$/.test(row.value)), "Each plugin should state a numeric component count.").toBe(true);
    const headerTile = await evalIn(browser, `Boolean(document.querySelector('[data-testid="catalog-identity-tile"]'))`);
    expect(headerTile, "The marketplace detail header should reuse the directory identity tile.").toBe(true);
    await sleep(500);
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "The marketplace detail header keeps a prominent identity tile beside its name",
      "The detail lists plugins with component counts in a comparable column",
      "No 'Something went wrong' or error banner is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  await evalIn(browser, `(() => {
    const rows = [...document.querySelectorAll('[data-testid="catalog-row"]')];
    rows[rows.length - 1]?.scrollIntoView({ block: "end" });
    return true;
  })()`);
  await waitFor(browser, `(() => {
    const rows = [...document.querySelectorAll('[data-testid="catalog-row"]')];
    const last = rows[rows.length - 1];
    if (!last) return false;
    const box = last.getBoundingClientRect();
    return box.bottom > 0 && box.bottom <= window.innerHeight + 2;
  })()`, { timeoutMs: 20_000, label: "last marketplace plugin row in view" });
  const tailMoved = await evalIn(browser, `(() => {
    const list = document.querySelector('[data-testid="catalog-list"]');
    let ancestor = list?.parentElement ?? null;
    while (ancestor) {
      if (ancestor.scrollTop > 0) return true;
      ancestor = ancestor.parentElement;
    }
    return document.documentElement.scrollTop > 0 || document.body.scrollTop > 0;
  })()`);
  expect(
    tailMoved,
    "Scrolling to the tail must actually move the plugin list; a list that fits on one screen cannot yield a distinct tail frame.",
  ).toBe(true);
  {
    const badges = parseStrings(
      await evalIn(browser, `[...document.querySelectorAll('[data-testid="catalog-row-badge"]')]
        .map((node) => node.textContent?.trim() ?? "")`),
      "Readiness badges",
    );
    expect(badges.every((badge) => badge !== "Cloud ready"), "No row should advertise routine Cloud ready status.").toBe(true);
    expect(
      badges.length,
      "A badge should appear exactly for plugins the resolved-marketplace API says need action.",
    ).toBe(needsAction);
    await sleep(500);
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "No plugin row advertises 'Cloud ready'",
      "The marketplace stays visually quiet except for badges on plugins that need attention",
      "No 'Something went wrong' or error banner is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  await navigate(browser, den.webUrl, "/dashboard/plugins");
  await waitForText(browser, "Plugins", { timeoutMs: 30_000 });
  await waitFor(browser, `Boolean(document.querySelector('[data-testid="catalog-row"]'))`, {
    timeoutMs: 20_000,
    label: "plugin catalogue rows",
  });
  {
    const rows = await readRows(browser);
    expect(rows.length > 0, "The plugin directory should render the same divided list.").toBe(true);
    expect([...new Set(rows.map((row) => row.right))], "Component counts should share one right edge.").toHaveLength(1);
    const tabs = parseStrings(
      await evalIn(browser, `[...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim() ?? "")`),
      "Plugin tabs",
    );
    expect(tabs.every((tab) => /\d/.test(tab)), `Every tab should carry its count. Saw: ${tabs.join(" | ")}`).toBe(true);
    await sleep(500);
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "The plugin directory uses the same divided list shape with aligned component counts",
      "Every tab label visibly carries a numeric count",
      "No 'Something went wrong' or error banner is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  const clicked = await evalIn(browser, `(() => {
    const row = document.querySelector('[data-testid="catalog-row"]');
    row?.click();
    return Boolean(row);
  })()`);
  expect(clicked, "The first plugin row should be clickable.").toBe(true);
  await waitFor(browser, `document.readyState === "complete" && location.pathname.includes('/dashboard/plugins/')`, {
    timeoutMs: 30_000,
    label: "plugin detail route loaded",
  });
  await waitFor(browser, `Boolean(document.querySelector('[data-testid="catalog-identity-tile"]'))`, {
    timeoutMs: 20_000,
    label: "plugin detail identity tile",
  });
  await waitForText(browser, "Updated", { timeoutMs: 20_000 });
  {
    const header = parsePluginHeader(await evalIn(browser, `(() => {
      const tile = document.querySelector('[data-testid="catalog-identity-tile"]');
      const heading = document.querySelector('h1');
      return {
        tile: tile?.textContent?.trim() ?? "",
        title: heading?.textContent?.trim() ?? "",
        meta: heading?.parentElement?.parentElement?.innerText ?? "",
      };
    })()`));
    expect(
      header.title.length > 0 && header.tile === header.title.slice(0, 1).toUpperCase(),
      `The detail header should carry the clicked plugin's monogram. Saw: ${JSON.stringify(header)}`,
    ).toBe(true);
    expect(header.meta.includes("Updated"), "Provenance and recency should sit under the plugin title.").toBe(true);
    expect(header.meta.includes("Cloud ready"), "The plugin header should not repeat routine readiness.").toBe(false);
    await sleep(500);
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "The plugin detail opens with a letter identity tile beside the plugin name",
      "One quiet provenance line under the title includes when the plugin was updated",
      "No 'Cloud ready' readiness badge is visible",
      "No 'Something went wrong' or error banner is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }
});
