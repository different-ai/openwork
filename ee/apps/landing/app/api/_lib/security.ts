import { checkBotId } from "botid/server";

type FixedWindowEntry = {
  count: number;
  resetAt: number;
};

const minimumSubmissionAgeMs = 1500;
const maximumSubmissionAgeMs = 1000 * 60 * 60;
const defaultAllowedOrigins = [
  "https://openworklabs.com",
  "https://www.openworklabs.com",
  "https://openwork.software",
  "https://www.openwork.software",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3005",
  "http://127.0.0.1:3005",
];

const store = globalThis as typeof globalThis & {
  __openworkLandingRateLimitStore?: Map<string, FixedWindowEntry>;
};

const rateLimitStore = store.__openworkLandingRateLimitStore ?? new Map<string, FixedWindowEntry>();
store.__openworkLandingRateLimitStore = rateLimitStore;

function currentTime() {
  return Date.now();
}

function readClientIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  return forwarded || realIp || "unknown";
}

function getRequestOrigin(request: Request) {
  try {
    return new URL(request.url).origin;
  } catch {
    return "";
  }
}

export function getAllowedOrigins(request: Request) {
  const configured = String(process.env.LANDING_FORM_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([getRequestOrigin(request), ...defaultAllowedOrigins, ...configured].filter(Boolean));
}

export function validateTrustedOrigin(request: Request) {
  const origin = request.headers.get("origin")?.trim() ?? "";
  if (!origin) {
    return { ok: false as const, status: 403, error: "A trusted browser origin is required." };
  }
  if (!getAllowedOrigins(request).has(origin)) {
    return { ok: false as const, status: 403, error: "Origin is not allowed." };
  }
  return { ok: true as const, origin };
}

export function buildResponseHeaders(request: Request) {
  const origin = request.headers.get("origin")?.trim() ?? "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (origin && getAllowedOrigins(request).has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

export function jsonResponse(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: buildResponseHeaders(request),
  });
}

export function applyFixedWindowRateLimit(input: {
  key: string;
  windowMs: number;
  max: number;
}) {
  const now = currentTime();
  const current = rateLimitStore.get(input.key);
  if (!current || current.resetAt <= now) {
    rateLimitStore.set(input.key, { count: 1, resetAt: now + input.windowMs });
    return { ok: true as const, retryAfterSeconds: 0 };
  }

  if (current.count >= input.max) {
    return {
      ok: false as const,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }

  current.count += 1;
  rateLimitStore.set(input.key, current);
  return { ok: true as const, retryAfterSeconds: 0 };
}

export function rateLimitFormRequest(request: Request, route: string) {
  return applyFixedWindowRateLimit({
    key: `${route}:${readClientIp(request)}`,
    windowMs: 60_000,
    max: 5,
  });
}

export async function verifyFormBotProtection() {
  const result = await checkBotId();
  if (result.isBot) {
    return { ok: false as const, status: 403, error: "Bot traffic is not allowed for this form." };
  }
  return { ok: true as const };
}

export function validateAntiSpamFields(input: { website?: string; startedAt?: number | string }) {
  if (typeof input.website === "string" && input.website.trim()) {
    return { ok: false as const, status: 400, error: "Invalid form submission." };
  }

  const startedAt = typeof input.startedAt === "number"
    ? input.startedAt
    : typeof input.startedAt === "string" && input.startedAt.trim()
      ? Number(input.startedAt)
      : Number.NaN;

  if (!Number.isFinite(startedAt)) {
    return { ok: false as const, status: 400, error: "Missing submission timing metadata." };
  }

  const ageMs = currentTime() - startedAt;
  if (ageMs < minimumSubmissionAgeMs || ageMs > maximumSubmissionAgeMs) {
    return { ok: false as const, status: 400, error: "Invalid form submission timing." };
  }

  return { ok: true as const };
}
