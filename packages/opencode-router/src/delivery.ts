export type DeliveryErrorCode =
  | "auth"
  | "forbidden"
  | "not_found"
  | "invalid_target"
  | "rate_limited"
  | "payload_too_large"
  | "unsupported_media"
  | "network"
  | "timeout"
  | "unknown";

export type DeliveryError = {
  code: DeliveryErrorCode;
  message: string;
  retryable: boolean;
  status?: number;
};

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function coerceStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    error_code?: unknown;
    response?: { status?: unknown };
    data?: { status?: unknown };
  };

  const maybe = [
    record.status,
    record.statusCode,
    record.error_code,
    record.response?.status,
    record.data?.status,
  ];

  for (const value of maybe) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function coerceCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code.trim().toUpperCase() : "";
}

function coerceMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown delivery error";
}

export function classifyDeliveryError(error: unknown): DeliveryError {
  const status = coerceStatus(error);
  const code = coerceCode(error);
  const message = coerceMessage(error);
  const lower = message.toLowerCase();

  if (status === 401 || lower.includes("invalid_auth") || lower.includes("unauthorized")) {
    return { code: "auth", message, retryable: false, status };
  }
  if (status === 403 || lower.includes("forbidden") || lower.includes("not_in_channel")) {
    return { code: "forbidden", message, retryable: false, status };
  }
  if (status === 404 || lower.includes("chat not found") || lower.includes("channel_not_found")) {
    return { code: "not_found", message, retryable: false, status };
  }
  if (status === 400 && (lower.includes("chat_id") || lower.includes("invalid peer") || lower.includes("invalid slack peer"))) {
    return { code: "invalid_target", message, retryable: false, status };
  }
  if (status === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
    return { code: "rate_limited", message, retryable: true, status };
  }
  if (status === 413 || lower.includes("too large") || lower.includes("file_too_large")) {
    return { code: "payload_too_large", message, retryable: false, status };
  }
  if (lower.includes("unsupported") || lower.includes("cannot upload") || lower.includes("not allowed for this message type")) {
    return { code: "unsupported_media", message, retryable: false, status };
  }
  if (status === 408 || lower.includes("timeout") || lower.includes("timed out")) {
    return { code: "timeout", message, retryable: true, status };
  }
  if ((status !== undefined && status >= 500) || RETRYABLE_NETWORK_CODES.has(code) || lower.includes("fetch failed")) {
    return { code: "network", message, retryable: true, status };
  }

  return { code: "unknown", message, retryable: false, status };
}

type RetryLogger = {
  warn?: (payload: unknown, message?: string) => void;
};

function withJitter(baseMs: number): number {
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(baseMs * 0.2)));
  return baseMs + jitter;
}

export async function withDeliveryRetry<T>(
  operation: string,
  run: () => Promise<T>,
  options: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    logger?: RetryLogger;
  } = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseDelayMs = Math.max(50, options.baseDelayMs ?? 250);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 4_000);

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await run();
    } catch (error) {
      const classified = classifyDeliveryError(error);
      if (!classified.retryable || attempt >= maxAttempts) {
        throw error;
      }

      const delayMs = Math.min(maxDelayMs, withJitter(baseDelayMs * 2 ** (attempt - 1)));
      options.logger?.warn?.(
        {
          operation,
          attempt,
          maxAttempts,
          delayMs,
          code: classified.code,
          status: classified.status,
          message: classified.message,
        },
        "delivery operation failed; retrying",
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
