export type ResponseMeta = {
  requestId: string;
  timestamp: string;
};

export type SuccessResponse<TData> = {
  ok: true;
  data: TData;
  meta: ResponseMeta;
};

export type ErrorCode =
  | "bad_gateway"
  | "conflict"
  | "forbidden"
  | "internal_error"
  | "invalid_request"
  | "not_found"
  | "not_implemented"
  | "service_unavailable"
  | "unauthorized";

export type ErrorDetail = {
  message: string;
  path?: Array<string | number>;
};

export type ErrorResponse = {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: Array<ErrorDetail>;
  };
};

export class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Array<ErrorDetail>,
  ) {
    super(message);
    this.name = "RouteError";
  }
}

export function createResponseMeta(requestId: string, now: Date = new Date()): ResponseMeta {
  return {
    requestId,
    timestamp: now.toISOString(),
  };
}

export function buildSuccessResponse<TData>(requestId: string, data: TData, now: Date = new Date()): SuccessResponse<TData> {
  return {
    ok: true,
    data,
    meta: createResponseMeta(requestId, now),
  };
}

export function buildErrorResponse(input: {
  requestId: string;
  code: ErrorCode;
  message: string;
  details?: Array<ErrorDetail>;
}): ErrorResponse {
  return {
    ok: false,
    error: {
      code: input.code,
      message: input.message,
      requestId: input.requestId,
      details: input.details,
    },
  };
}
