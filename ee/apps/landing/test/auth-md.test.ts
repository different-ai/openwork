import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../middleware";

const publicDir = join(import.meta.dir, "../public");
const authMd = readFileSync(join(publicDir, "auth.md"), "utf8");
const llms = readFileSync(join(publicDir, "llms.txt"), "utf8");

describe("/auth.md", () => {
  test("follows the auth.md walkthrough order", () => {
    const headings = ["# auth.md", "## Step 1: Discover", "## Step 2: Pick a method", "## Step 3: Register", "## Step 4: Claim ceremony", "## Step 5: Exchange the assertion", "## Step 6: Use the access_token", "## Errors", "## Revocation"];
    let last = -1;
    for (const heading of headings) {
      const at = authMd.indexOf(heading);
      expect(at, heading).toBeGreaterThan(last);
      last = at;
    }
  });

  test("documents the exact endpoints Den implements", () => {
    for (const needle of [
      "https://api.openworklabs.com/.well-known/oauth-protected-resource/mcp/agent",
      "https://api.openworklabs.com/.well-known/oauth-authorization-server",
      "https://app.openworklabs.com/api/auth/oauth2/token",
      "POST https://api.openworklabs.com/v1/bootstrap/workspace",
      "POST https://api.openworklabs.com/v1/bootstrap/workspace/{bootstrap_id}/claim",
      "GET https://api.openworklabs.com/v1/bootstrap/workspace/{bootstrap_id}/claim",
      "POST https://api.openworklabs.com/api/auth/device/code",
      "POST https://api.openworklabs.com/api/auth/device/token",
      "https://app.openworklabs.com/device?user_code=",
      "https://app.openworklabs.com/claim?user_code=",
      "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer",
      "\"client_id\": \"openwork-cli\"",
      "requires_claim",
      "requires_admin",
      "Bearer error=\"insufficient_scope\"",
    ]) {
      expect(authMd, needle).toContain(needle);
    }
  });

  test("only claims the anonymous registration method", () => {
    expect(authMd).toContain('"identity_types_supported": ["anonymous"]');
    expect(authMd).not.toContain("POST /agent/identity");
    expect(authMd).not.toContain("urn:workos:agent-auth:grant-type:claim");
    expect(authMd).not.toContain('"events_endpoint"');
  });

  test("is linked from llms.txt and covered by the crawler middleware", () => {
    expect(llms).toContain("https://openworklabs.com/auth.md");
    expect(config.matcher).toContain("/auth.md");
  });
});
