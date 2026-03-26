import { checkBotId } from "botid/server";

type FixedWindowEntry = {
  count: number;
  resetAt: number;
};

const defaultAllowedOrigins = [
  "https://app.openworklabs.com",
  "https://openworklabs.com",
  "https://app.openwork.software",
  "https://openwork.software",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "tauri://localhost",
  "http://tauri.localhost",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3006",
  "http://127.0.0.1:3006",
];

const store = globalThis as typeof globalThis & {
  __openworkShareRateLimitStore?: Map<string, FixedWindowEntry>;
};

const rateLimitStore = store.__openworkShareRateLimitStore ?? new Map<string, FixedWindowEntry>();
store.__openworkShareRateLimitStore = rateLimitStore;

function now() {
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
  const configured = String(process.env.OPENWORK_PUBLISHER_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([getRequestOrigin(request), ...defaultAllowedOrigins, ...configured].filter(Boolean));
}

export function buildCorsHeaders(request: Request) {
  const origin = request.headers.get("origin")?.trim() ?? "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept,X-OpenWork-Bundle-Type,X-OpenWork-Schema-Version,X-OpenWork-Name",
  };
  if (origin && getAllowedOrigins(request).has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

export function validateTrustedOrigin(request: Request) {
  const origin = request.headers.get("origin")?.trim() ?? "";
  if (!origin) {
    return { ok: false as const, status: 403, message: "A trusted browser origin is required." };
  }
  if (!getAllowedOrigins(request).has(origin)) {
    return { ok: false as const, status: 403, message: "Origin is not allowed to publish bundles." };
  }
  return { ok: true as const, origin };
}

export function applyFixedWindowRateLimit(input: {
  key: string;
  windowMs: number;
  max: number;
}) {
  const currentTime = now();
  const current = rateLimitStore.get(input.key);
  if (!current || current.resetAt <= currentTime) {
    rateLimitStore.set(input.key, { count: 1, resetAt: currentTime + input.windowMs });
    return { ok: true as const, retryAfterSeconds: 0 };
  }

  if (current.count >= input.max) {
    return {
      ok: false as const,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - currentTime) / 1000)),
    };
  }

  current.count += 1;
  rateLimitStore.set(input.key, current);
  return { ok: true as const, retryAfterSeconds: 0 };
}

export function rateLimitPublishRequest(request: Request) {
  return applyFixedWindowRateLimit({
    key: `publish:${readClientIp(request)}`,
    windowMs: 60_000,
    max: 20,
  });
}

export async function verifyShareBotProtection(request: Request) {
  const requestOrigin = getRequestOrigin(request);
  const origin = request.headers.get("origin")?.trim() ?? "";
  if (!origin || origin !== requestOrigin) {
    return { ok: true as const };
  }

  const result = await checkBotId();
  if (result.isBot) {
    return { ok: false as const, status: 403, message: "Bot traffic is not allowed for bundle publishing." };
  }

  return { ok: true as const };
}
