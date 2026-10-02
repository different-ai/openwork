import { describe, expect, test } from "bun:test";
import type { GatewayMemberConnection } from "../app/(den)/dashboard/_components/gateway-member-connections-data";
import {
  buildLibraryModelProviders,
  matchesModelQuery,
  modelNamesSummary,
  modelVendor,
  type UsableProvider,
} from "../app/(den)/dashboard/_components/library-models";
import { parseLibraryFilter } from "../app/(den)/dashboard/_components/library-view";

const model = (name: string, upstreamModelId: string, credentialSetId = "gcs_member") => ({
  id: `gwm_${upstreamModelId}`, name, upstreamModelId, modelGroupName: "Everyone", credentialSetId, credentialSetName: "Your Google account",
});

const googleCloud: UsableProvider = {
  id: "ipr_google", providerId: "google-vertex", name: "Google Cloud", credentialStatus: "member_auth_required", models: [],
  authorizationRequests: [{ credentialSetId: "gcs_member", name: "Your Google account", models: [
    model("Gemini 2.5 Pro", "gemini-2.5-pro"), model("Gemini 2.5 Flash", "gemini-2.5-flash"), model("Claude Sonnet 4.5", "claude-sonnet-4-5@20250929"),
  ] }],
};
const mistral: UsableProvider = {
  id: "ipr_mistral", providerId: "mistral", name: "Mistral", credentialStatus: "org_credential_missing", models: [], authorizationRequests: [],
};
const anthropic: UsableProvider = {
  id: "ipr_anthropic", providerId: "anthropic", name: "Anthropic", credentialStatus: "ready",
  models: [model("Claude Opus 4.1", "claude-opus-4-1", "gcs_org")], authorizationRequests: [],
};
const samsSet: GatewayMemberConnection = {
  providerId: "ipr_google", credentialSetId: "gcs_member", providerName: "Google Cloud", name: "Your Google account",
  ready: false, hasAccess: true, hasCredential: false, configurationRequired: false, authorizationRevision: null, accountEmail: null,
};

describe("My Library, Models", () => {
  test("?show=models opens the Models chip", () => {
    expect(parseLibraryFilter("models")).toBe("models");
  });

  test("each provider has exactly one state: ready, needs your sign-in, or waiting on your admin", () => {
    const rows = buildLibraryModelProviders([googleCloud, mistral, anthropic], [samsSet]);
    expect(rows.map((row) => [row.name, row.state])).toEqual([
      ["Anthropic", "ready"], ["Google Cloud", "needs_signin"], ["Mistral", "blocked"],
    ]);
    const google = rows.find((row) => row.id === "ipr_google");
    expect(google?.signInSet?.credentialSetId).toBe("gcs_member");
    expect(google?.models.map((entry) => entry.name)).toEqual(["Claude Sonnet 4.5", "Gemini 2.5 Flash", "Gemini 2.5 Pro"]);
    expect(rows.find((row) => row.id === "ipr_anthropic")?.signInSet).toBeNull();
  });

  test("after signing in the row is ready and says which account is in use", () => {
    const signedIn: UsableProvider = { ...googleCloud, credentialStatus: "ready", models: googleCloud.authorizationRequests[0]?.models ?? [], authorizationRequests: [] };
    const [row] = buildLibraryModelProviders([signedIn], [{ ...samsSet, ready: true, hasCredential: true, authorizationRevision: "r1", accountEmail: "sam@example.com" }]);
    expect(row?.state).toBe("ready");
    expect(row?.account).toBe("sam@example.com");
  });

  test("a sign-in the admin has to fix never offers Sign in", () => {
    const [row] = buildLibraryModelProviders([googleCloud], [{ ...samsSet, configurationRequired: true }]);
    expect(row?.state).toBe("blocked");
    expect(row?.signInSet).toBeNull();
    const [removed] = buildLibraryModelProviders([googleCloud], [{ ...samsSet, hasAccess: false }]);
    expect(removed?.state).toBe("blocked");
  });

  test("a Claude model served by Google Cloud is still made by Anthropic", () => {
    expect(modelVendor({ name: "Claude Sonnet 4.5", upstreamModelId: "claude-sonnet-4-5@20250929" }, { name: "Google Cloud", providerId: "google-vertex" }))
      .toEqual({ name: "Claude Sonnet 4.5", vendor: "Anthropic", vendorIconSlug: "anthropic" });
    expect(modelVendor({ name: "Something new", upstreamModelId: "acme-1" }, { name: "Google Cloud", providerId: "google-vertex" }).vendor).toBe("Google Cloud");
  });

  test("rows summarize model names in words and filter by any model name", () => {
    const names = ["Claude Sonnet 4.5", "GPT-5.4", "Gemini 2.5 Flash", "A", "B"].map((name) => ({ name, vendor: "x", vendorIconSlug: "x" }));
    expect(modelNamesSummary(names)).toBe("Claude Sonnet 4.5, GPT-5.4, Gemini 2.5 Flash and 2 more");
    expect(modelNamesSummary(names.slice(0, 2))).toBe("Claude Sonnet 4.5, GPT-5.4");
    const [row] = buildLibraryModelProviders([googleCloud], [samsSet]);
    if (!row) throw new Error("missing row");
    expect(matchesModelQuery(row, "flash")).toBe(true);
    expect(matchesModelQuery(row, "codestral")).toBe(false);
  });
});
