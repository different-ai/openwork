import { fetchBundleJsonById } from "../../../../server/_lib/blob-store.ts";
import { wantsDownload } from "../../../../server/_lib/share-utils.ts";
import { buildRequestLike } from "../../../../server/_lib/request-like.ts";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const routeParams = await params;
  const id = String(routeParams?.id ?? "").trim();
  if (!id) {
    return Response.json({ message: "id is required" }, { status: 400 });
  }

  try {
    const { blob, rawBuffer } = await fetchBundleJsonById(id);
    const requestLike = buildRequestLike({
      headers: request.headers,
      searchParams: request.nextUrl.searchParams
    });
    const responseHeaders = new Headers({
      Vary: "Accept",
      "Cache-Control": "public, max-age=3600",
      "Content-Type": blob.contentType || "application/json"
    });

    if (wantsDownload(requestLike)) {
      responseHeaders.set("Content-Disposition", `attachment; filename="openwork-bundle-${id}.json"`);
    }

    return new Response(rawBuffer as unknown as BodyInit, {
      status: 200,
      headers: responseHeaders
    });
  } catch {
    return Response.json({ message: "Not found" }, { status: 404 });
  }
}
