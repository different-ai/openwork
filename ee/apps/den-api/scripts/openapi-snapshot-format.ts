export function formatOpenApiSnapshot(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
