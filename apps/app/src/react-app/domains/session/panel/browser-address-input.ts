export function browserAddressDestination(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Enter a search or website address.");
  if (value === "about:blank") return value;

  if (/^(?:[/\\]|~[/\\]|[a-z]:[/\\])/i.test(value)) throw new Error("Enter a website address instead of a file path.");

  const hostname = value.split(/[/?#]/, 1)[0];
  const local = /^(?:localhost|127(?:\.\d+){3}|\[::1\])(?::\d+)?$/i.test(hostname);
  const hostPort = /^[^\s/:]+:\d+$/.test(hostname);
  const explicitScheme = /^[a-z][a-z\d+.-]*:/i.test(value) && !hostPort;
  const looksLikeAddress = local || hostPort || explicitScheme || (hostname.length > 0
    && !/\s/.test(hostname) && (hostname.includes(".") || value.startsWith(hostname + "/")));

  if (looksLikeAddress) {
    const url = URL.parse(explicitScheme ? value : (local ? "http://" : "https://") + value);
    if (!url || !["http:", "https:"].includes(url.protocol)) throw new Error("Enter an HTTP or HTTPS website address.");
    return url.href;
  }
  const search = new URL("https://www.google.com/search");
  search.searchParams.set("q", value);
  return search.href;
}
