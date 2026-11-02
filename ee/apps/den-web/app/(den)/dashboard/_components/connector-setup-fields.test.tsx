import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OAuthAppFields, createOAuthAppDraft } from "./connector-setup-fields";
import { manualOAuthDraft, reviewPublishedAddresses } from "./manual-oauth-draft";
import { DenCheckbox } from "../../_components/ui/checkbox";

const callbackUrl = "https://api.example.test/custom/path/callback?runtime=verified";
const addresses = { authorizationEndpoint: "https://identity.example.test/authorize", tokenEndpoint: "https://tokens.example.test/token" };
function render({ setupValidation = false, secretRequired = true, manual = false, callback = true, confirmed = false } = {}) {
  const draft = { ...createOAuthAppDraft(), clientId: "test-client", clientSecret: "", trustConfirmed: confirmed, manualDraft: manual ? reviewPublishedAddresses(manualOAuthDraft(), addresses, true) : manualOAuthDraft() };
  // Omit url: these app fields render independently of the organization-backed discovery row.
  return renderToStaticMarkup(<OAuthAppFields setupValidation={setupValidation} secretRequired={secretRequired} saving={false} error={null} onSave={() => undefined} draft={draft} onDraftChange={() => undefined} callbackUrl={callback ? callbackUrl : undefined} formId="oauth-test-form" />);
}

test("preset setup retains placeholder-only app fields, with no callback or confirmation", () => {
  const html = render({ manual: true });
  assert.doesNotMatch(html, /<label[^>]*>Client ID<\/label>/);
  assert.doesNotMatch(html, /<label[^>]*>Client secret/);
  assert.doesNotMatch(html, /oauth-app-callback|manual-oauth-trust-confirmation|novalidate/);
  assert.match(html, /placeholder="Client ID"/);
});

test("revised app fields have persistent credential labels and accurate optionality", () => {
  const required = render({ setupValidation: true });
  assert.match(required, /<label[^>]*>Client ID<\/label>/);
  assert.match(required, /<label[^>]*>Client secret<\/label>/);
  assert.doesNotMatch(required, /Client secret \(optional\)/);
  assert.match(render({ setupValidation: true, secretRequired: false }), /<label[^>]*>Client secret \(optional\)<\/label>/);
  assert.match(required, /aria-label="Client ID"/);
  assert.match(required, /aria-label="Client secret"/);
  assert.match(required, /novalidate=""/i);
});

test("revised callback shows only the exact supplied address with a non-submit Copy action", () => {
  const html = render({ setupValidation: true });
  assert.match(html, /<code[^>]*>https:\/\/api.example.test\/custom\/path\/callback\?runtime=verified<\/code>/);
  assert.match(html, /<button[^>]*type="button"[^>]*aria-label="Copy callback URL"/);
  assert.doesNotMatch(render({ setupValidation: true, callback: false }), /oauth-app-callback|Copy callback URL/);
});

test("the shared confirmation checkbox retains accessible and native checked form state", () => {
  const unchecked = renderToStaticMarkup(<DenCheckbox name="trustConfirmed" aria-label="Approve these addresses" checked={false} />);
  assert.match(unchecked, /role="checkbox"[^>]*aria-checked="false"/);
  assert.match(unchecked, /<input(?=[^>]*type="checkbox")(?=[^>]*name="trustConfirmed")[^>]*>/);
  assert.doesNotMatch(unchecked, /<input(?=[^>]*name="trustConfirmed")(?=[^>]*checked="")[^>]*>/);

  const checked = renderToStaticMarkup(<DenCheckbox name="trustConfirmed" aria-label="Approve these addresses" checked disabled />);
  assert.match(checked, /role="checkbox"[^>]*aria-checked="true"/);
  assert.match(checked, /aria-label="Approve these addresses"/);
  assert.match(checked, /<input(?=[^>]*type="checkbox")(?=[^>]*name="trustConfirmed")(?=[^>]*checked="")(?=[^>]*disabled="")[^>]*>/);
});

test("both presentations retain password masking, no-capture and password-manager protections", () => {
  for (const setupValidation of [false, true]) {
    const html = render({ setupValidation });
    assert.match(html, /type="password"/);
    assert.match(html, /data-ph-no-capture/);
    assert.match(html, /data-1p-ignore="true"/);
    assert.match(html, /data-lpignore="true"/);
    assert.match(html, /data-bwignore="true"/);
    assert.match(html, /autoComplete="new-password"/i);
  }
});
