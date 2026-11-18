#!/usr/bin/env node
// Facilitator-only reset of fictional business data. Never put the reset key in a URL.
import { pathToFileURL } from "node:url";

export const RESET_CONFIRMATION = "RESET ALL SAMPLE DATA";

export function parseResetOptions(argv) {
  let origin;
  let all = false;
  let confirm = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--url" && origin === undefined) origin = argv[++index];
    else if (arg === "--all" && !all) all = true;
    else if (arg === "--confirm" && !confirm) confirm = true;
    else throw new Error("Usage: node src/workshop-reset.mjs --url <workshop origin> --all [--confirm]");
  }
  if (!all || !origin) throw new Error("Provide --url and --all. Add --confirm only when ready to erase all fictional business changes.");
  let url;
  try { url = new URL(origin); } catch { throw new Error("Workshop URL must be an HTTP(S) origin."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Workshop URL must be an HTTP(S) origin without credentials, path, query or fragment.");
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Hosted reset requires HTTPS.");
  return { origin: url.origin, confirm };
}

export async function resetWorkshop({ origin, confirm }, { token = process.env.OPEN_WORKPLACE_RESET_TOKEN, trustedOrigin = process.env.OPEN_WORKPLACE_RESET_URL, request = fetch } = {}) {
  if (!confirm) return { performed: false, message: "Preview only: --confirm will erase every attendee's changes in Outlook, Calendar, Drive, Jira and Confluence. Browser identities and OAuth connections are retained. VM files and chat history are not changed." };
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error("Set the facilitator's OPEN_WORKPLACE_RESET_TOKEN in this process environment. Never pass it in the URL.");
  // The key is only ever sent to the one workshop it was configured for.
  let trusted;
  try { trusted = new URL(String(trustedOrigin)).origin; } catch { trusted = ""; }
  if (!trusted || trusted !== origin) throw new Error("Set OPEN_WORKPLACE_RESET_URL to this workshop's origin next to its reset key; the key is never sent to any other host.");
  let response;
  try {
    response = await request(`${origin}/_workshop/reset-all`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(45_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ confirm: RESET_CONFIRMATION }),
    });
  } catch { throw new Error("Reset request did not complete. Check the workshop before retrying; do not assume its data was reset."); }
  if (!response.ok) {
    if (response.status === 409) throw new Error("Workshop is busy. Finish current requests, then explicitly run the reset again.");
    if ([401, 403, 404].includes(response.status)) throw new Error(`Facilitator reset is unavailable or unauthorized (HTTP ${response.status}).`);
    throw new Error(`Workshop reset failed (HTTP ${response.status}). Inspect the host logs before retrying.`);
  }
  let result;
  try { result = await response.json(); } catch { throw new Error("Reset returned an invalid receipt. Verify the environment before retrying."); }
  if (result?.ok !== true || result.reset !== "all-sample-data") throw new Error("Reset did not return a confirmed success receipt.");
  return { performed: true, message: "All five services are back to their starting sample data. Browser identities and OAuth connections are retained. VM files and chat history were not changed." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await resetWorkshop(parseResetOptions(process.argv.slice(2)));
    console.log(result.message);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
