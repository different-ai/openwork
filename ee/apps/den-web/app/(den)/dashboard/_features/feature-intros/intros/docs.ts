/** Public docs site; each intro's "Read the docs" builds on it (DESIGN.md I8). */
export const OPENWORK_DOCS_URL = "https://openworklabs.com/docs";

/** A docs page under `packages/docs`, e.g. `docsPage("ai-gateway/limits")`. */
export function docsPage(path: string): string {
  return `${OPENWORK_DOCS_URL}/${path.replace(/^\/+/, "")}`;
}
