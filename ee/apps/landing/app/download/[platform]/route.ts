// GET /download/<platform> → 302 to the current public installer for that OS.
// See lib/download-platforms.ts for the slugs.
import { downloadPlatformHref, downloadPlatforms, isDownloadPlatform } from "../../../lib/download-platforms";
import { getGithubData } from "../../../lib/github";

export const revalidate = 3600;

export function generateStaticParams() {
  return Object.keys(downloadPlatforms).map((platform) => ({ platform }));
}

export async function GET(_request: Request, context: { params: Promise<{ platform: string }> }) {
  const { platform } = await context.params;
  if (!isDownloadPlatform(platform)) {
    const valid = Object.keys(downloadPlatforms).map((slug) => `  https://openworklabs.com/download/${slug}`).join("\n");
    return new Response(`Unknown platform "${platform}". Use one of:\n${valid}\n`, {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const { installers } = await getGithubData();
  return new Response(null, {
    status: 302,
    headers: {
      location: downloadPlatformHref(installers, platform),
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
    },
  });
}
