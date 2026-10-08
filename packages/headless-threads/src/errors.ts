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
  /** True when retrying the same call may succeed; null when unclassified. */
  readonly retryable: boolean | null;

  constructor(input: {
    code: string;
    message: string;
    method: string;
    path: string;
    status?: number;
    body?: unknown;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = "HeadlessThreadError";
    this.code = input.code;
    this.method = input.method;
    this.path = input.path;
    this.status = input.status ?? null;
    this.body = input.body;
    this.retryable = input.retryable ?? null;
  }
}
