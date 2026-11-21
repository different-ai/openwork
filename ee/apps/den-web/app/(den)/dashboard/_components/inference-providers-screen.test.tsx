import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { asInferenceProvider } from "./inference-provider-request";
import { ProviderRow } from "./inference-providers-screen";

function renderTeamProvider(credentialStatus: "ready" | "org_credential_missing") {
  const provider = asInferenceProvider({
    id: "provider-1",
    providerId: "openai",
    name: "OpenAI",
    status: "active",
    credentialMode: "org",
    credentialStatus: "org_credential_missing",
    models: [],
    modelIds: ["gpt-model"],
    credentialSets: [{ id: "shared", name: "Shared key", credentialMode: "org", status: "active", configured: credentialStatus === "ready", credentialStatus }],
    accessGrants: [{ id: "grant", modelGroupId: "models", credentialSetId: "shared", audience: { type: "team", teamId: "team-1" } }],
  });
  assert.ok(provider);
  return renderToStaticMarkup(<ProviderRow provider={provider} orgSlug="test-org" orgContext={null} />);
}

test("a team-only provider is ready to manage when its shared key is ready, even if the viewer has no models", () => {
  const html = renderTeamProvider("ready");
  assert.match(html, /Status: Ready/);
  assert.match(html, />Manage<\/a>/);
});

test("a team-only provider with no ready shared key still needs setup", () => {
  const html = renderTeamProvider("org_credential_missing");
  assert.match(html, /Status: Add a key/);
  assert.match(html, />Set up<\/a>/);
});

function renderVertexSignInProvider(configured: boolean) {
  // The viewer has not signed in with Google, so the provider and its set read member_auth_required for them.
  const provider = asInferenceProvider({
    id: "provider-2",
    providerId: "google-vertex",
    name: "Vertex",
    status: "active",
    credentialMode: "member",
    credentialStatus: "member_auth_required",
    models: [],
    modelIds: ["gemini-model"],
    credentialSets: [{ id: "google", name: "Google sign-in", credentialMode: "member", status: "active", configured, credentialStatus: "member_auth_required" }],
    accessGrants: [{ id: "grant", modelGroupId: "models", credentialSetId: "google", audience: { type: "organization" } }],
  });
  assert.ok(provider);
  return renderToStaticMarkup(<ProviderRow provider={provider} orgSlug="test-org" orgContext={null} />);
}

test("a Google sign-in provider is ready once its sign-in is set up, before the viewer signs in", () => {
  const html = renderVertexSignInProvider(true);
  assert.match(html, /Status: Ready/);
  assert.doesNotMatch(html, /Add a key/);
});

test("a Google sign-in provider without its OAuth client still needs setup", () => {
  assert.match(renderVertexSignInProvider(false), /Status: Add a key/);
});
