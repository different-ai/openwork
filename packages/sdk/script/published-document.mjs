import { readFile, writeFile } from "node:fs/promises";

// The published API reference (Mintlify reads packages/docs) is generated from
// the same export as the SDK, so both stay current together.
export const publishedDocumentPath = "packages/docs/openapi.json";

export const stalePublishedDocumentMessage =
  `${publishedDocumentPath} is stale. Run pnpm sdk:generate and commit ${publishedDocumentPath}.`;

/**
 * Generate mode writes the exported document to the tracked path. Check mode
 * never writes: it rejects an exported document that differs from the tracked
 * one so CI fails instead of silently publishing a stale reference.
 */
export async function syncPublishedDocument({ exported, path, check }) {
  if (!check) {
    await writeFile(path, exported);
    return;
  }
  if (!exported.equals(await readFile(path))) {
    throw new Error(stalePublishedDocumentMessage);
  }
}
