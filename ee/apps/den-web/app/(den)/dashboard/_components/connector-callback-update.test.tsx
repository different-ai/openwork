import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectorCallbackUpdate } from "./connector-callback-update";
import { connectorOAuthClientUpdate } from "./connector-oauth-client-update";

const callbackUrl = "https://api.example.test/custom/path/callback?runtime=verified";
const unchanged = {
  clientChanged: false,
  callbackUpdateRequired: true,
  callbackUpdateConfirmed: false,
  clientId: "saved-client-id",
  clientSecret: "",
};

test("callback recovery shows the exact active callback and a non-submit copy action", () => {
  const html = renderToStaticMarkup(<ConnectorCallbackUpdate callbackUrl={callbackUrl} confirmed={false} onConfirmedChange={() => undefined} />);
  assert.match(html, /The deployment domain changed/);
  assert.match(html, /<code[^>]*>https:\/\/api.example.test\/custom\/path\/callback\?runtime=verified<\/code>/);
  assert.match(html, /<button[^>]*type="button"[^>]*aria-label="Copy callback URL"/);
  assert.match(html, /I updated the callback URL in the provider/);
  assert.match(html, /role="checkbox"[^>]*aria-checked="false"/);
});

test("confirmation checkbox uses the shared checked form state", () => {
  const html = renderToStaticMarkup(<ConnectorCallbackUpdate callbackUrl={callbackUrl} confirmed onConfirmedChange={() => undefined} />);
  assert.match(html, /role="checkbox"[^>]*aria-checked="true"/);
  assert.match(html, /<input(?=[^>]*name="callbackUpdateConfirmed")(?=[^>]*checked="")[^>]*>/);
});

test("unchanged client credentials are omitted until the required callback update is confirmed", () => {
  assert.equal(connectorOAuthClientUpdate(unchanged), undefined);
  assert.deepEqual(connectorOAuthClientUpdate({ ...unchanged, callbackUpdateConfirmed: true }), { clientId: "saved-client-id" });
});

test("unrelated saves never resubmit unchanged credentials outside callback recovery", () => {
  assert.equal(connectorOAuthClientUpdate({ ...unchanged, callbackUpdateRequired: false }), undefined);
  assert.equal(connectorOAuthClientUpdate({ ...unchanged, callbackUpdateRequired: false, callbackUpdateConfirmed: true }), undefined);
});

test("ordinary client edits still send credentials and optional secrets", () => {
  assert.deepEqual(connectorOAuthClientUpdate({ ...unchanged, callbackUpdateRequired: false, clientChanged: true, clientId: " new-id ", clientSecret: " new-secret " }), { clientId: "new-id", clientSecret: "new-secret" });
  assert.deepEqual(connectorOAuthClientUpdate({ ...unchanged, callbackUpdateRequired: false, clientChanged: true }), { clientId: "saved-client-id" });
  assert.equal(connectorOAuthClientUpdate({ ...unchanged, callbackUpdateConfirmed: true, clientId: " " }), undefined);
});
