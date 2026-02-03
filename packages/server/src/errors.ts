import type { ApiErrorBody } from "./types.js";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function formatError(err: ApiError): ApiErrorBody {
  return {
    code: err.code,
    message: err.message,
    details: err.details,
  };
}
