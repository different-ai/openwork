import { readBaseUrlEnv, type BaseUrlEnv } from "@openwork/types/url";
import { denUrls } from "@openwork-ee/utils";

export function readDenApiBase(env: BaseUrlEnv = process.env): string | null {
  const configured = readBaseUrlEnv(env, "DEN_API_BASE") ?? readBaseUrlEnv(env, "DEN_API_PUBLIC_URL");
  if (configured) return configured;
  try {
    return denUrls(env).api;
  } catch {
    return null;
  }
}
