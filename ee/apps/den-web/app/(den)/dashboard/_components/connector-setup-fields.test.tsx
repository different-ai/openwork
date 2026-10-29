import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OAuthAppFields, createOAuthAppDraft } from "./connector-setup-fields";
import { manualOAuthDraft, reviewPublishedAddresses } from "./manual-oauth-draft";

const callbackUrl = "https://api.example.test/custom/path/callback?runtime=verified";
const addresses = { authorizationEndpoint: "https://identity.example.test/authorize", tokenEndpoint: "https://tokens.example.test/token" };
function render({ revisedSetup = false, secretRequired = true, manual = false, callback = true, confirmed = false } = {}) {
  const draft = { ...createOAuthAppDraft(), clientId: "test-client", clientSecret: "", trustConfirmed: confirmed, manualDraft: manual ? reviewPublishedAddresses(manualOAuthDraft(), addresses, true) : manualOAuthDraft() };
  // Omit url: these app fields render independently of the organization-backed discovery row.
  return renderToStaticMarkup(<OAuthAppFields revisedSetup={revisedSetup} secretRequired={secretRequired} saving={false} error={null} onSave={() => undefined} draft={draft} onDraftChange={() => undefined} callbackUrl={callback ? callbackUrl : undefined} formId="oauth-test-form" />);
}

test("flag off retains placeholder-only app fields, with no callback or confirmation", () => {
  const html = render({ manual: true });
  assert.doesNotMatch(html, /<label[^>]*>Client ID<\/label>/);
  assert.doesNotMatch(html, /<label[^>]*>Client secret/);
  assert.doesNotMatch(html, /oauth-app-callback|manual-oauth-trust-confirmation|novalidate/);
  assert.match(html, /placeholder="Client ID"/);
});

test("revised app fields have persistent credential labels and accurate optionality", () => {
  const required = render({ revisedSetup: true });
  assert.match(required, /<label[^>]*>Client ID<\/label>/);
  assert.match(required, /<label[^>]*>Client secret<\/label>/);
  assert.doesNotMatch(required, /Client secret \(optional\)/);
  assert.match(render({ revisedSetup: true, secretRequired: false }), /<label[^>]*>Client secret \(optional\)<\/label>/);
  assert.match(required, /aria-label="Client ID"/);
  assert.match(required, /aria-label="Client secret"/);
  assert.match(required, /novalidate=""/i);
});

test("revised callback shows only the exact supplied address with a non-submit Copy action", () => {
  const html = render({ revisedSetup: true });
  assert.match(html, /<code[^>]*>https:\/\/api.example.test\/custom\/path\/callback\?runtime=verified<\/code>/);
  assert.match(html, /<button[^>]*type="button"[^>]*aria-label="Copy callback URL"/);
  assert.doesNotMatch(render({ revisedSetup: true, callback: false }), /oauth-app-callback|Copy callback URL/);
});

test("both presentations retain password masking, no-capture and password-manager protections", () => {
  for (const revisedSetup of [false, true]) {
    const html = render({ revisedSetup });
    assert.match(html, /type="password"/);
    assert.match(html, /data-ph-no-capture/);
    assert.match(html, /data-1p-ignore="true"/);
    assert.match(html, /data-lpignore="true"/);
    assert.match(html, /data-bwignore="true"/);
    assert.match(html, /autoComplete="new-password"/i);
  }
});
