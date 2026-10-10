/** Write the published contract as fully indented JSON: one value per line.
 * Git merges line by line and treats edits on neighbouring lines as a
 * conflict, so long lines (a whole path or schema, or a copied enum such as
 * the feature-flag list) make unrelated PRs conflict. One value per line lets
 * two PRs that touch different routes, schemas or enum values merge cleanly.
 * Key order is kept as generated (route-registration order) so formatting
 * never reorders the SDK's methods or types. */
export function formatOpenApiSnapshot(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
