export function publicRequestUrl(request: Request): URL {
  const url = new URL(request.url)
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase()
  if (proto === "https" || proto === "http") {
    url.protocol = `${proto}:`
  }
  return url
}
