import { isRecord } from "./records.js";

export type OpenWorkFetch = (url: string, init?: RequestInit) => Promise<Response>;

export function serverUrl(): string {
  return String(process.env.OPENWORK_SERVER_URL || "").replace(/\/$/, "");
}

export function serverToken(): string {
  return String(process.env.OPENWORK_SERVER_TOKEN || "");
}

export function requireOpenWorkServer(): { url: string; token: string } {
  const url = serverUrl();
  const token = serverToken();
  if (!url || !token) {
    throw new Error("OpenWork extension tools are only available when OpenCode is launched by OpenWork.");
  }
  return { url, token };
}

export async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return { message: text };
  }
}

function getStringProperty(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const property = value[key];
  return typeof property === "string" ? property : null;
}

export function errorMessage(payload: unknown, fallback: string): string {
  return getStringProperty(payload, "message") ?? getStringProperty(payload, "code") ?? fallback;
}

export async function getJson(
  path: string,
  fetcher: OpenWorkFetch = fetch,
  fallback = "OpenWork server request failed",
): Promise<unknown> {
  const { url, token } = requireOpenWorkServer();
  const response = await fetcher(url + path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await parseResponse(response);
  if (!response.ok) throw new Error(errorMessage(payload, fallback));
  return payload;
}

export async function postJson(
  path: string,
  body: unknown,
  fetcher: OpenWorkFetch = fetch,
  fallback = "OpenWork extension call failed",
): Promise<unknown> {
  const { url, token } = requireOpenWorkServer();
  const response = await fetcher(url + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await parseResponse(response);
  if (!response.ok) throw new Error(errorMessage(payload, fallback));
  return payload;
}
