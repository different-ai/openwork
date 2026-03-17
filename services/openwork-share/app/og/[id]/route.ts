import { fetchBundleJsonById } from "../../../server/_lib/blob-store.ts";
import { buildBundleOgImageModel, buildRootOgImageModel, renderBundleOgImage, renderRootOgImage } from "../../../server/_lib/render-og-image.ts";
import { renderOgPngResponse } from "../../../server/_lib/render-og-image-response.tsx";

export const runtime = "nodejs";

function getCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept"
  };
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders()
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const routeParams = await params;
  const id = String(routeParams?.id ?? "root").trim() || "root";
  const format = new URL(request.url).searchParams.get("format") === "svg" ? "svg" : "png";
  const cacheControl =
    id === "root"
      ? "public, max-age=3600"
      : "public, max-age=3600, stale-while-revalidate=86400";

  if (id === "root") {
    if (format === "svg") {
      return new Response(renderRootOgImage(), {
        status: 200,
        headers: {
          ...getCorsHeaders(),
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": cacheControl
        }
      });
    }

    return renderOgPngResponse(buildRootOgImageModel(), {
      ...getCorsHeaders(),
      "Cache-Control": cacheControl
    });
  }

  try {
    const { rawJson } = await fetchBundleJsonById(id);
    if (format === "svg") {
      return new Response(renderBundleOgImage({ id, rawJson }), {
        status: 200,
        headers: {
          ...getCorsHeaders(),
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": cacheControl
        }
      });
    }

    return renderOgPngResponse(buildBundleOgImageModel({ id, rawJson }), {
      ...getCorsHeaders(),
      "Cache-Control": cacheControl
    });
  } catch {
    console.error(`[share-og] failed to render bundle ${id}`);
    const fallbackCacheControl = "public, max-age=300, stale-while-revalidate=3600";

    if (format === "svg") {
      return new Response(renderRootOgImage(), {
        status: 200,
        headers: {
          ...getCorsHeaders(),
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": fallbackCacheControl
        }
      });
    }

    return renderOgPngResponse(buildRootOgImageModel(), {
      ...getCorsHeaders(),
      "Cache-Control": fallbackCacheControl
    });
  }
}
