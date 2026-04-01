"use client";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

type FieldsResult<T> =
  | { data: T; error?: undefined }
  | { data?: undefined; error: unknown };

function encodeBasicAuth(username: string, password: string) {
  return globalThis.btoa(`${username}:${password}`);
}

export function createLabOpencodeClient(
  baseUrl: string,
  auth?: { username?: string | null; password?: string | null },
) {
  const username = auth?.username?.trim() || "";
  const password = auth?.password?.trim() || "";
  const headers = username && password
    ? { Authorization: `Basic ${encodeBasicAuth(username, password)}` }
    : undefined;
  return createOpencodeClient({ baseUrl, fetch: globalThis.fetch, headers });
}

export function unwrap<T>(result: FieldsResult<T>): NonNullable<T> {
  if (result && typeof result === "object" && "data" in result && result.data !== undefined) {
    return result.data as NonNullable<T>;
  }

  const error = result && typeof result === "object" && "error" in result ? result.error : result;
  if (error instanceof Error) {
    throw error;
  }
  if (typeof error === "string") {
    throw new Error(error);
  }
  throw new Error(JSON.stringify(error ?? "Unknown error"));
}
