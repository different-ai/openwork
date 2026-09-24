import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";
import { describeOAuthError } from "../app/connect/error/describe-oauth-error";
import { OAuthErrorContent } from "../app/connect/error/oauth-error-screen";

function params(input: Record<string, string>) {
  return new URLSearchParams(input);
}

describe("OAuth error page", () => {
  test("explains an unregistered redirect in plain words with a next step", () => {
    const state = describeOAuthError(params({ error: "invalid_redirect", error_description: "invalid redirect uri" }));
    expect(state.title).toBe("The app's return address isn't registered");
    expect(state.detail).toBe("invalid redirect uri");
    expect(state.advice[0]).toMatch(/register the return address/i);
  });

  test("maps the other Better Auth authorize errors and falls back safely", () => {
    expect(describeOAuthError(params({ error: "invalid_client" })).title).toBe("OpenWork doesn't recognize this app");
    expect(describeOAuthError(params({ error: "client_disabled" })).title).toBe("This app has been turned off");
    expect(describeOAuthError(params({ error: "unauthorized_client" })).title).toBe("This app can't use this sign-in method");
    expect(describeOAuthError(params({ error: "unsupported_response_type" })).title).toBe("The sign-in request was malformed");
    expect(describeOAuthError(params({ error: "invalid_request" })).title).toBe("The sign-in request was malformed");
    const unknown = describeOAuthError(params({ error: "<script>alert(1)</script>" }));
    expect(unknown.code).toBe("unknown");
    expect(unknown.title).toBe("Sign-in couldn't be completed");
    expect(describeOAuthError(new URLSearchParams()).detail).toBeNull();
    expect(describeOAuthError(params({ error_description: "x".repeat(900) })).detail).toHaveLength(500);
  });

  test("renders the shared status shell with the diagnostics collapsed", () => {
    const markup = renderToStaticMarkup(createElement(OAuthErrorContent, {
      state: describeOAuthError(params({ error: "invalid_redirect", error_description: "invalid redirect <b>uri</b>" })),
    }));
    expect(markup).toContain("openwork-mark.svg");
    expect(markup).toContain("The app&#x27;s return address isn&#x27;t registered");
    expect(markup).toContain("role=\"alert\"");
    expect(markup).toContain("<details");
    expect(markup).toContain("Technical details");
    expect(markup).toContain("invalid_redirect");
    // The provider's description is rendered as text, never as markup.
    expect(markup).not.toContain("<b>uri</b>");
    expect(markup).toContain("&lt;b&gt;uri&lt;/b&gt;");
    expect(markup).toContain("Back to OpenWork");
    expect(markup).not.toMatch(/ERROR|Go Home|Ask AI/);
  });

  test("the route is public, indexes nothing and sends no referrer", () => {
    const source = readFileSync(fileURLToPath(new URL("../app/connect/error/page.tsx", import.meta.url)), "utf8");
    expect(source).toContain("robots: { index: false, follow: false }");
    expect(source).toContain("referrer: \"no-referrer\"");
  });
});
