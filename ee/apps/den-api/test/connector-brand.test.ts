import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  apexDomain,
  brandHintFor,
  brandIconCandidates,
  connectorDisplayName,
  connectorIconCandidates,
  safeBrandImageUrl,
} from "@openwork/types/connector-brand";

const favicon = (domain: string) => `https://www.google.com/s2/favicons?sz=64&domain=${domain}`;

describe("Den brand compatibility", () => {
  it("preserves explicit, bundled, Simple Icons, favicon ordering", () => {
    assert.deepEqual(brandIconCandidates({ iconUrl: "https://images.example/logo.png", serviceUrl: "https://mcp.slack.com/private?token=secret" }), [
      "https://images.example/logo.png", "/integrations/slack.svg", favicon("slack.com"),
    ]);
    assert.deepEqual(brandIconCandidates({ simpleIconSlug: "okta", serviceUrl: "https://okta.com" }), ["/integrations/okta.svg", favicon("okta.com")]);
    assert.deepEqual(brandIconCandidates({ simpleIconSlug: "figma" }), ["https://cdn.simpleicons.org/figma"]);
    assert.equal(apexDomain("https://mcp.notion.com/path"), "notion.com");
    assert.equal(safeBrandImageUrl("https://images.example/logo.png"), "https://images.example/logo.png");
    assert.equal(safeBrandImageUrl("javascript:alert(1)"), undefined);
  });
});

describe("connector brands", () => {
  it("cleans redundant slugs without erasing distinct connection labels", () => {
    assert.equal(connectorDisplayName(" Coffee SF / coffee-sf "), "Coffee SF");
    assert.equal(connectorDisplayName("Context7 / context7"), "Context7");
    assert.equal(connectorDisplayName("Slack / engineering"), "Slack / engineering");
    assert.equal(connectorDisplayName("Coffee SF / coffee-sf-production"), "Coffee SF / coffee-sf-production");
  });

  it("matches known whole words and official domains, not incidental substrings", () => {
    assert.deepEqual(brandHintFor("My Google Workspace / production"), { serviceUrl: "https://google.com" });
    assert.deepEqual(brandHintFor("Microsoft Entra ID (production)"), { serviceUrl: "https://microsoft.com" });
    assert.deepEqual(brandHintFor("Exa / exa"), { serviceUrl: "https://exa.ai" });
    assert.deepEqual(brandHintFor("Context7 / context7"), { serviceUrl: "https://context7.com" });
    assert.deepEqual(brandHintFor("DeepWiki (shared)"), { serviceUrl: "https://deepwiki.com" });
    for (const name of ["example", "slackish", "nonlinear", "notional", "mydeepwiki"]) {
      assert.deepEqual(brandHintFor(name), {});
    }
  });

  it("resolves known logos before metadata or deployment addresses", () => {
    assert.deepEqual(connectorIconCandidates({ name: "Exa", url: "https://evil.example/mcp?token=secret", iconUrl: "https://cdn.simpleicons.org/figma" }), [
      "https://cdn.simpleicons.org/exa", "https://cdn.simpleicons.org/figma", favicon("exa.ai"),
    ]);
    assert.deepEqual(connectorIconCandidates({ name: "Context7" }), ["/integrations/context7.png", favicon("context7.com")]);
    assert.deepEqual(connectorIconCandidates({ name: "DeepWiki", url: "https://localhost:9999" }), [favicon("deepwiki.com")]);
  });

  it("gives native providers priority over conflicting names, URLs and metadata", () => {
    assert.equal(connectorIconCandidates({ name: "Slack", nativeProviderKey: "google-workspace", iconUrl: "/integrations/slack.svg" })[0], "/integrations/google.svg");
    assert.equal(connectorIconCandidates({ name: "Slack", nativeProviderKey: "microsoft-365", iconUrl: "/integrations/slack.svg" })[0], favicon("microsoft.com"));
  });

  it("accepts only trusted static icon sources and deduplicates", () => {
    assert.deepEqual(connectorIconCandidates({ name: "Custom", iconUrl: "/integrations/custom-logo.svg" }), ["/integrations/custom-logo.svg"]);
    assert.deepEqual(connectorIconCandidates({ name: "Custom", iconUrl: "https://cdn.simpleicons.org/github" }), ["https://cdn.simpleicons.org/github"]);
    assert.deepEqual(connectorIconCandidates({ name: "Figma", iconUrl: "https://cdn.simpleicons.org/figma" }), ["https://cdn.simpleicons.org/figma"]);
    for (const iconUrl of [
      "https://arbitrary.example/icon.png", "//cdn.simpleicons.org/slack", "/other/logo.svg", "/integrations/../secret.svg",
      "/integrations/logo.svg?token=secret", "https://cdn.simpleicons.org/slack?token=secret", "https://cdn.simpleicons.org/slack#secret",
      "https://cdn.simpleicons.org.evil.example/slack", "https://user:pass@cdn.simpleicons.org/slack", "http://cdn.simpleicons.org/slack",
      "https://cdn.simpleicons.org:444/slack", "https://cdn.simpleicons.org/../../secret", "https://cdn.simpleicons.org/\nslack",
    ]) assert.deepEqual(connectorIconCandidates({ name: "Custom", iconUrl }), [], iconUrl);
  });

  it("uses only sanitized public hostnames for unknown services", () => {
    const input = { name: "Coffee SF / coffee-sf", url: "https://mcp.coffee.example:8080/private/token?secret=hidden#secret" };
    assert.deepEqual(brandHintFor(input.name, input.url), { serviceUrl: "https://mcp.coffee.example" });
    assert.deepEqual(connectorIconCandidates(input), [favicon("coffee.example")]);
    assert.deepEqual(connectorIconCandidates({ name: "Custom", url: "https://PUBLIC.EXAMPLE./secret" }), [favicon("public.example")]);
  });

  it("rejects IPs, credentials, local/internal hosts and non-HTTP URLs", () => {
    for (const url of [
      "http://localhost/mcp", "http://service.localhost/mcp", "https://127.0.0.1/private", "http://127.1/mcp", "http://2130706433/mcp",
      "https://[::1]/mcp", "https://[2001:db8::1]/mcp", "https://10.0.0.1/mcp", "https://service.test/mcp", "https://a.b.local/mcp",
      "https://a.b.internal/mcp", "https://user:password@public.example/mcp", "https://intranet/mcp", "file:///etc/passwd",
      "https://public.example/secret\npath", "https://public.example\\@private.internal/mcp",
    ]) {
      assert.deepEqual(brandHintFor("Custom", url), {}, url);
      assert.deepEqual(connectorIconCandidates({ name: "Custom", url }), [], url);
    }
  });
});
