import { isDenTypeId } from "@openwork-ee/utils/typeid";
import { mcpAppIdSchema, mcpAppServerPath } from "@openwork/types/mcp-app";

export function readArtifactLink({ id, org }: { id?: unknown; org?: unknown }) {
  const appId = mcpAppIdSchema.safeParse(id);
  if (!appId.success) return null;
  return { id: appId.data, org: isDenTypeId("organization", org) ? org : undefined };
}

export function artifactOpenUrl({ denApiUrl, id, org }: { denApiUrl: string; id?: unknown; org?: unknown }): string | null {
  const link = readArtifactLink({ id, org });
  if (!link) return null;

  let url: URL;
  try {
    url = new URL(denApiUrl);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;

  url.pathname = `${url.pathname.replace(/\/+$/, "")}${mcpAppServerPath(link.id)}`;
  url.search = "";
  url.hash = "";
  if (link.org) url.searchParams.set("org", link.org);
  return url.href;
}
