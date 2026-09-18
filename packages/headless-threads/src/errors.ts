export function isHeadlessModelAccessError(error: unknown): boolean {
  if (typeof error === "string") return /^(?:Model not found\s*:|ProviderModelNotFoundError\b|ProviderAuthError\b)/i.test(error);
  if (error === null || typeof error !== "object") return false;
  for (const key of ["code", "name"]) {
    const value: unknown = Reflect.get(error, key);
    if (value === "model_access_lost" || value === "ProviderModelNotFoundError" || value === "ProviderAuthError") return true;
  }
  const message: unknown = Reflect.get(error, "message");
  return typeof message === "string" && isHeadlessModelAccessError(message);
}

/**
 * A single error type for every headless thread failure, so a caller running
 * many threads can classify failures without string matching.
 */
export class HeadlessThreadError extends Error {
  readonly code: string;
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly body: unknown;

  constructor(input: {
    code: string;
    message: string;
    method: string;
    path: string;
    status?: number;
    body?: unknown;
  }) {
    super(input.message);
    this.name = "HeadlessThreadError";
    this.code = input.code;
    this.method = input.method;
    this.path = input.path;
    this.status = input.status ?? null;
    this.body = input.body;
  }
}
