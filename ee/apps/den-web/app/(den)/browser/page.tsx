import { CloudBrowserScreen } from "../_components/cloud-browser-screen";

function firstParam(value: string | string[] | undefined, maxLength: number): string | null {
  const raw = typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
  const trimmed = raw?.replace(/\s+/g, " ").trim().slice(0, maxLength) ?? "";
  return trimmed || null;
}

/** Hand-off links: /browser?site=app.example.com&assistant=WorkBot */
export default async function CloudBrowserPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return <CloudBrowserScreen site={firstParam(params.site, 253)} assistantName={firstParam(params.assistant, 40) ?? "OpenWork"} />;
}
