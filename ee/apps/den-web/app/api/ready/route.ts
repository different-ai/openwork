import { NextResponse } from "next/server";
import { joinBaseUrl, readBaseUrlEnv } from "@openwork/types/url";
import { denUrls } from "@openwork-ee/utils";

import { denWebLogger } from "../../../observability/runtime-logger";

export const dynamic = "force-dynamic";

type CheckStatus = "ok" | "error";

type ReadinessPayload = {
  ok: boolean;
  service: "den-web";
  checks: {
    configuration: CheckStatus;
    upstream: CheckStatus;
  };
  missing?: string[];
};

const upstreamTimeoutMs = 2_000;

function json(payload: ReadinessPayload, status: number) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function checkUpstream(apiBase: string): Promise<CheckStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs);

  try {
    const response = await fetch(joinBaseUrl(apiBase, "ready"), {
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok ? "ok" : "error";
  } catch (error) {
    denWebLogger.warn("den-web readiness upstream check failed", {
      upstream_path: "/ready",
      error_name: error instanceof Error ? error.name : typeof error,
    });
    return "error";
  } finally {
    clearTimeout(timeout);
  }
}

function readDenApiBase() {
  const urls = denUrls(process.env);
  return readBaseUrlEnv(process.env, "DEN_API_BASE") ?? urls.api;
}

export async function GET() {
  let apiBase: string | null = null;
  let hasPublicWebOrigin = true;
  try {
    apiBase = readDenApiBase();
  } catch {
    hasPublicWebOrigin = false;
  }
  const missing: string[] = [];
  if (!hasPublicWebOrigin) {
    missing.push("DEN_BASE_URL");
  }

  if (missing.length > 0 || !apiBase) {
    return json({
      ok: false,
      service: "den-web",
      checks: { configuration: "error", upstream: "error" },
      missing,
    }, 503);
  }

  const upstream = await checkUpstream(apiBase);
  const ok = upstream === "ok";

  return json({
    ok,
    service: "den-web",
    checks: { configuration: "ok", upstream },
  }, ok ? 200 : 503);
}
