import { NextRequest } from "next/server";

const DEFAULT_API_BASE = "https://api.openwork.software";
const DEFAULT_AUTH_ORIGIN = "https://den-control-plane-openwork.onrender.com";
const apiBase = (process.env.DEN_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, "");
const authOrigin = (process.env.DEN_AUTH_ORIGIN ?? DEFAULT_AUTH_ORIGIN).replace(/\/+$/, "");

export const dynamic = "force-dynamic";

function buildTargetUrl(request: NextRequest, segments: string[]): string {
  const incoming = new URL(request.url);
  let targetPath = segments.join("/");

  if (!targetPath) {
    const prefix = "/api/den/";
    if (incoming.pathname.startsWith(prefix)) {
      targetPath = incoming.pathname.slice(prefix.length);
    } else if (incoming.pathname === "/api/den") {
      targetPath = "";
    }
  }

  const upstream = new URL(`${apiBase}/${targetPath}`);
  upstream.search = incoming.search;
  return upstream.toString();
}

function buildHeaders(request: NextRequest, contentType: string | null): Headers {
  const headers = new Headers();
  const copyHeaders = ["accept", "authorization", "cookie", "user-agent", "x-requested-with"];

  for (const key of copyHeaders) {
    const value = request.headers.get(key);
    if (value) {
      headers.set(key, value);
    }
  }

  if (contentType) {
    headers.set("content-type", contentType);
  }

  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }

  headers.set("origin", authOrigin);

  return headers;
}

async function proxy(request: NextRequest, segments: string[] = []) {
  const targetUrl = buildTargetUrl(request, segments);
  const contentType = request.headers.get("content-type");

  const init: RequestInit = {
    method: request.method,
    headers: buildHeaders(request, contentType),
    redirect: "manual"
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  const upstream = await fetch(targetUrl, init);
  const body = await upstream.arrayBuffer();

  const responseHeaders = new Headers();
  const passThroughHeaders = ["content-type", "set-cookie", "location"];

  for (const key of passThroughHeaders) {
    const value = upstream.headers.get(key);
    if (value) {
      responseHeaders.set(key, value);
    }
  }

  return new Response(body, {
    status: upstream.status,
    headers: responseHeaders
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
