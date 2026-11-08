import { describe, expect, test } from "vitest";
import { accountChooserPage, consentPage } from "./pages.ts";

const account = { sub: "eval-user", name: "Alex Morgan", email: "alex@acme.test" };
const common = { interaction: "transaction", applicationName: "OpenWork", action: "/mock-oauth/consent" };

describe("offline Google-shaped OAuth pages", () => {
  test("account chooser shows Google mark, identity rows and explicit local-provider footer", () => {
    const page = accountChooserPage({ ...common, accounts: [account] });
    expect(page).toContain("Choose an account");
    expect(page).toContain("to continue to");
    expect(page).toContain('aria-label="Google"');
    expect(page).toContain('class="avatar" aria-hidden="true">A</span>');
    expect(page).toContain(account.name);
    expect(page).toContain(account.email);
    expect(page).toContain("Local OAuth test provider");
    expect(page).not.toMatch(/<(script|link|img)\b/i);
    expect(page).not.toMatch(/\b(src|href)=/i);
    expect(page).toContain('name="viewport"');
    expect(page).toContain("@media (max-width: 760px)");
    expect(page).toContain(":focus-visible");
  });

  test("consent names requested data and keeps Continue/Cancel bound to protocol values", () => {
    const page = consentPage({ ...common, account, scope: "openid email profile" });
    expect(page).toContain("Sign in to OpenWork");
    expect(page).toContain("Confirm your identity");
    expect(page).toContain("See your email address");
    expect(page).toContain("See your name and profile picture");
    expect(page).toContain('value="approve">Continue</button>');
    expect(page).toContain('value="deny">Cancel</button>');
    expect(page).toContain("Local OAuth test provider");
    expect(page).not.toMatch(/<(script|link|img)\b/i);
  });

  test("describes Google URL-shaped scopes and deduplicates permissions", () => {
    const page = consentPage({ ...common, account, scope: "email email https://www.googleapis.com/auth/userinfo.profile custom-scope" });
    expect(page.match(/See your email address/g)).toHaveLength(1);
    expect(page).toContain("See your name and profile picture");
    expect(page).toContain("Access the requested permission: custom-scope");
  });

  test("escapes identity, app, scope, action and transaction attributes", () => {
    const malicious = '<script>alert("x")</script>';
    const common = { interaction: malicious, applicationName: malicious, action: malicious };
    const identity = { sub: malicious, name: malicious, email: malicious };
    for (const page of [accountChooserPage({ ...common, accounts: [identity] }), consentPage({ ...common, account: identity, scope: malicious })]) {
      expect(page).not.toContain("<script>");
      expect(page).toContain("&lt;script&gt;");
      expect(page).toContain('name="interaction" value="&lt;script&gt;');
    }
  });
});
