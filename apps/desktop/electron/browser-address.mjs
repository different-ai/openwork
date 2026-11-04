// What the person typed in the built-in browser's address bar -> the URL to
// load. Behaves like a normal browser omnibox: addresses open, local dev
// servers open over http, anything else is searched. Agent navigation never
// goes through here; it always passes a real URL.

const SEARCH_URL = "https://www.google.com/search?q=";
const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?::\d{1,5})?(?:[/?#].*)?$/i;
// host.tld, optional port and path; the TLD has at least two letters.
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}\.?(?::\d{1,5})?(?:[/?#].*)?$/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?:[/?#].*)?$/;

/** @param {unknown} input @returns {string} */
export function resolveAddressBarInput(input) {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text || text === "about:blank") return "about:blank";
  if (/^https?:\/\//i.test(text)) return text;
  if (/\s/.test(text)) return SEARCH_URL + encodeURIComponent(text);
  if (LOCAL_HOST.test(text)) return `http://${text}`;
  if (DOMAIN.test(text) || IPV4.test(text)) return `https://${text}`;
  return SEARCH_URL + encodeURIComponent(text);
}
