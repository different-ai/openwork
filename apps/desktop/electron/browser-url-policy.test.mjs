import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  blockedBrowserHost,
  blockedBrowserPageUrl,
  blockedBrowserUrlMessage,
  compileBrowserUrlPolicy,
  isBlockedBrowserPageUrl,
  isBrowserUrlAllowed,
  isBrowserUrlSubjectToPolicy,
} from "./browser-url-policy.mjs";

describe("browser URL allowlist policy", () => {
  it("treats an absent, empty, or wildcard list as unrestricted", () => {
    assert.equal(compileBrowserUrlPolicy(null), null);
    assert.equal(compileBrowserUrlPolicy(undefined), null);
    assert.equal(compileBrowserUrlPolicy("example.com"), null);
    assert.equal(compileBrowserUrlPolicy([]), null);
    assert.equal(compileBrowserUrlPolicy(["", "   "]), null);
    assert.equal(compileBrowserUrlPolicy(["example.com", "*"]), null);
    assert.equal(isBrowserUrlAllowed("https://anything.example", null), true);
  });

  it("compiles hosts case-insensitively and de-duplicates", () => {
    assert.deepEqual(compileBrowserUrlPolicy([" Example.COM. ", "example.com", 7, "Docs.Example.com"]), {
      hosts: ["example.com", "docs.example.com"],
    });
  });

  it("allows an exact host and its subdomains only", () => {
    const policy = compileBrowserUrlPolicy(["example.com", "127.0.0.1"]);
    assert.equal(isBrowserUrlAllowed("https://example.com/", policy), true);
    assert.equal(isBrowserUrlAllowed("https://EXAMPLE.com./path?q=1", policy), true);
    assert.equal(isBrowserUrlAllowed("http://docs.example.com:8080/a", policy), true);
    assert.equal(isBrowserUrlAllowed("http://127.0.0.1:4173/ok", policy), true);
    assert.equal(isBrowserUrlAllowed("https://www.google.com/", policy), false);
    assert.equal(isBrowserUrlAllowed("https://notexample.com/", policy), false);
    assert.equal(isBrowserUrlAllowed("https://example.com.evil.test/", policy), false);
    assert.equal(isBrowserUrlAllowed("http://localhost:4173/ok", policy), false);
    assert.equal(isBrowserUrlAllowed("http://127.0.0.2/", policy), false);
  });

  it("cannot be fooled by userinfo, encoded hosts, or a bare pattern in the path", () => {
    const policy = compileBrowserUrlPolicy(["example.com"]);
    assert.equal(isBrowserUrlAllowed("https://example.com@evil.test/", policy), false);
    assert.equal(isBrowserUrlAllowed("https://evil.test/example.com", policy), false);
    assert.equal(isBrowserUrlAllowed("https://evil.test/?next=https://example.com", policy), false);
    // Percent-encoded hosts canonicalize before matching, so this really is example.com.
    assert.equal(isBrowserUrlAllowed("https://EXAMPLE%2Ecom/", policy), true);
    assert.equal(isBrowserUrlAllowed("https://EXAMPLE%2Ecom.evil.test/", policy), false);
    assert.equal(isBrowserUrlAllowed("https://xn--bcher-kva.example/", compileBrowserUrlPolicy(["xn--bcher-kva.example"])), true);
    assert.equal(isBrowserUrlAllowed("https://bücher.example/", compileBrowserUrlPolicy(["xn--bcher-kva.example"])), true);
    assert.equal(isBrowserUrlAllowed("http://[::1]:4173/", compileBrowserUrlPolicy(["[::1]"])), true);
    assert.equal(isBrowserUrlAllowed("http://[::1]:4173/", policy), false);
    assert.equal(isBrowserUrlAllowed("https://", policy), false);
  });

  it("leaves internal non-http(s) plumbing alone", () => {
    const policy = compileBrowserUrlPolicy(["example.com"]);
    for (const url of [
      "about:blank",
      "data:text/html;charset=utf-8,%3Ctitle%3Eopenwork-browser-tab%3Ax%3C%2Ftitle%3E",
      "openwork://den-auth/grant",
      "openwork-dev://den-auth/grant",
      "chrome-error://chromewebdata/",
      "devtools://devtools/bundled/inspector.html",
    ]) {
      assert.equal(isBrowserUrlSubjectToPolicy(url), false, url);
      assert.equal(isBrowserUrlAllowed(url, policy), true, url);
    }
    assert.equal(isBrowserUrlSubjectToPolicy("HTTPS://example.com"), true);
  });

  it("renders a blocked page that names the host and escapes markup", () => {
    const pageUrl = blockedBrowserPageUrl("https://www.google.com/search?q=<b>");
    assert.ok(pageUrl.startsWith("data:text/html;charset=utf-8,"));
    assert.equal(isBlockedBrowserPageUrl(pageUrl), true);
    assert.equal(isBlockedBrowserPageUrl("https://www.google.com/"), false);
    const html = decodeURIComponent(pageUrl.slice(pageUrl.indexOf(",") + 1));
    assert.match(html, /<title>Blocked by your organization<\/title>/);
    assert.match(html, /<code>www\.google\.com<\/code>/);
    assert.equal(html.includes("<b>"), false);

    const hostile = decodeURIComponent(blockedBrowserPageUrl("not a url <script>").split(",").slice(1).join(","));
    assert.equal(hostile.includes("<script>"), false);
    assert.ok(hostile.includes("&lt;script&gt;"));

    assert.equal(blockedBrowserHost("https://docs.example.com:8443/x"), "docs.example.com");
    assert.equal(
      blockedBrowserUrlMessage("https://www.google.com/"),
      "Blocked by your organization: www.google.com is not on the approved website list.",
    );
  });
});
