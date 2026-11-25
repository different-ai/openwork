export const OPENWORK_DOCS_URL = "https://openworklabs.com/docs";

export function docsPage(path: string): string {
  return `${OPENWORK_DOCS_URL}/${path.replace(/^\/+/, "")}`;
}
