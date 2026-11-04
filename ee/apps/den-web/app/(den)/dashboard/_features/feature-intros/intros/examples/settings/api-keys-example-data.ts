/**
 * Sample data only: no API calls (DESIGN.md I7). Keys start with `den_` and are
 * sent in the `x-api-key` header, as the Den API documents.
 */
export const apiKeysExampleRows: ReadonlyArray<{ name: string; preview: string; owner: string; lastUsed: string }> = [
  { name: "CI deploy", preview: "den_a1b2…", owner: "Ada Lovelace", lastUsed: "Used 2 min ago" },
  { name: "Team provisioning", preview: "den_7f3c…", owner: "Ada Lovelace", lastUsed: "Used yesterday" },
  { name: "Usage export", preview: "den_e90d…", owner: "Grace Hopper", lastUsed: "Never used" },
];

export const apiKeysExampleRequest = 'curl https://api.openworklabs.com/v1/me -H "x-api-key: den_a1b2…"';
