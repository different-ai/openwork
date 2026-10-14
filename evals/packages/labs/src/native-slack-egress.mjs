// Loaded only in this journey's isolated Den children. An omitted or ignored
// endpoint override must fail here, never fall through to a real Slack API.
const originalFetch = globalThis.fetch;
globalThis.fetch = function syntheticSlackOnly(input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com")) {
    throw new Error("ENG-76 synthetic proof forbids real Slack traffic");
  }
  return originalFetch(input, init);
};
