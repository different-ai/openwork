import sharp from "sharp";
import { fetchBundleJsonById } from "../../../../server/_lib/blob-store.ts";
import { renderBundleOgImage, renderRootOgImage } from "../../../../server/_lib/render-og-image.ts";

export const runtime = "nodejs";

function getCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept"
  };
}

async function renderOgBody(svg: string, format: "svg" | "png") {
  if (format === "svg") return svg;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return new Uint8Array(buffer);
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
  const responseHeaders = new Headers({
    ...getCorsHeaders(),
    "Content-Type": format === "svg" ? "image/svg+xml; charset=utf-8" : "image/png",
    "Cache-Control":
      id === "root"
        ? "public, max-age=3600"
        : "public, max-age=3600, stale-while-revalidate=86400"
  });

  if (id === "root") {
    const svg = renderRootOgImage();
    return new Response(await renderOgBody(svg, format), {
      status: 200,
      headers: responseHeaders
    });
  }

  try {
    const { rawJson } = await fetchBundleJsonById(id);
    const svg = renderBundleOgImage({ id, rawJson });
    return new Response(await renderOgBody(svg, format), {
      status: 200,
      headers: responseHeaders
    });
  } catch {
    responseHeaders.set("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
    const svg = renderRootOgImage();
    return new Response(await renderOgBody(svg, format), {
      status: 200,
      headers: responseHeaders
    });
  }
}
