import type { Surface } from "@openwork/cdp";
import { evalIn } from "./desktop.ts";

export interface ConnectorCatalogFacts {
  summary: string;
  entries: { id: string; text: string; href: string; status: string }[];
  horizontalOverflow: boolean;
}

/** Observe rendered catalog rows, never React state or product source. */
export async function readConnectorCatalog(surface: Surface): Promise<ConnectorCatalogFacts> {
  const value = await evalIn(surface, `(() => ({
    summary: document.querySelector('[data-testid="connector-catalog-count"]')?.textContent?.trim(),
    entries: Array.from(document.querySelectorAll('[data-connector-id]'), row => ({
      id: row.getAttribute('data-connector-id'),
      text: row.innerText,
      href: row.querySelector('a')?.getAttribute('href'),
      status: row.querySelector('[data-testid^="connector-status-"]')?.textContent?.trim(),
    })),
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }))()`);
  if (!value || typeof value !== "object" || !("summary" in value) || typeof value.summary !== "string"
    || !("entries" in value) || !Array.isArray(value.entries)
    || !("horizontalOverflow" in value) || typeof value.horizontalOverflow !== "boolean") {
    throw new Error("The connector catalog did not expose its rendered summary and entries.");
  }
  const entries = value.entries.map((entry: unknown) => {
    if (!entry || typeof entry !== "object"
      || !("id" in entry) || typeof entry.id !== "string"
      || !("text" in entry) || typeof entry.text !== "string"
      || !("href" in entry) || typeof entry.href !== "string"
      || !("status" in entry) || typeof entry.status !== "string") {
      throw new Error("A connector row is missing its identity, link or setup status.");
    }
    return { id: entry.id, text: entry.text, href: entry.href, status: entry.status };
  });
  return { summary: value.summary, entries, horizontalOverflow: value.horizontalOverflow };
}
