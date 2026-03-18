import { NextRequest } from "next/server";
import { proxyUpstream } from "../../_lib/upstream-proxy";

export const dynamic = "force-dynamic";

async function proxy(request: NextRequest, segments: string[] = []) {
  return proxyUpstream(request, segments, {
    routePrefix: "/api/auth",
    upstreamPathPrefix: "api/auth",
    rewriteAuthLocationsToRequestOrigin: true,
  });
}

export async function GET(request: NextRequest) {
  return proxy(request);
}

export async function POST(request: NextRequest) {
  return proxy(request);
}

export async function PUT(request: NextRequest) {
  return proxy(request);
}

export async function PATCH(request: NextRequest) {
  return proxy(request);
}

export async function DELETE(request: NextRequest) {
  return proxy(request);
}
