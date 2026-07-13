import { z } from "zod"

export function isSafeOAuthRedirectUri(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.username || url.password || url.hash) return false
  if (url.protocol === "https:") return true
  if (url.protocol !== "http:") return false
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1"
}

export const oauthRedirectUriSchema = z.string().superRefine((value, context) => {
  if (!isSafeOAuthRedirectUri(value)) {
    context.addIssue({
      code: "custom",
      message: "Redirect URI must use HTTPS or HTTP on localhost, 127.0.0.1, or [::1], with no credentials or fragment",
    })
  }
})
