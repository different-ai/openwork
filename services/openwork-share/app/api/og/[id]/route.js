import { fetchBundleJsonById } from "../../../../server/_lib/blob-store.js";
import { renderBundleOgImage, renderRootOgImage } from "../../../../server/_lib/render-og-image.js";

export const runtime = "nodejs";

function getCorsHeaders() {
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

export async function GET(_request, { params }) {
  const routeParams = await params;
  const id = String(routeParams?.id ?? "root").trim() || "root";
  const responseHeaders = new Headers({
    ...getCorsHeaders(),
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control":
      id === "root"
        ? "public, max-age=3600"
        : "public, max-age=3600, stale-while-revalidate=86400"
  });

  if (id === "root") {
    return new Response(renderRootOgImage(), {
      status: 200,
      headers: responseHeaders
    });
  }

  try {
    const { rawJson } = await fetchBundleJsonById(id);
    return new Response(renderBundleOgImage({ id, rawJson }), {
      status: 200,
      headers: responseHeaders
    });
  } catch {
    return new Response(renderRootOgImage(), {
      status: 404,
      headers: responseHeaders
    });
  }
}
