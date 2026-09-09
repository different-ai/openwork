// Loaded only into owned Gmail proof processes, before product modules capture fetch.
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Gmail proof refused non-loopback provider traffic");
  }
  return originalFetch(input, init);
}, originalFetch);
