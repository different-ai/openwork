import assert from "node:assert/strict";
import { test } from "node:test";
import type { GatewayAccessGrantWrite, GatewayCredentialSet, GatewayModelGroup } from "@openwork/types/den/gateway";
import { filterSupportedGatewayCatalogModels, readSavedGatewayResourceId, syncInferenceProviderMatrix, type GatewayResourceWrite } from "./inference-provider-request";

test("catalog filtering keeps only models the gateway can route through the provider", () => {
  const npm = "@ai-sdk/google-vertex";
  const supported = [
    { id: "default", config: {} },
    { id: "matching-provider-override", config: { provider: { npm } } },
    { id: "matching-model-override", config: { npm } },
  ];
  const unsupported = [
    { id: "vertex-anthropic", config: { provider: { npm: "@ai-sdk/google-vertex/anthropic" } } },
    { id: "openai-compatible", config: { provider: { npm: "@ai-sdk/openai-compatible" } } },
    { id: "mistral", config: { provider: { npm: "@ai-sdk/mistral" } } },
    { id: "model-override", config: { npm: "@ai-sdk/openai" } },
    { id: "unresolved-template", config: { options: { baseURL: "${FOO}" } } },
    { id: "unresolved-provider-template", config: { provider: { options: { baseURL: "${FOO}" } } } },
  ];
  assert.deepEqual(filterSupportedGatewayCatalogModels({ npm }, [...unsupported, ...supported]), supported);
});

test("saved resource IDs come from the matching response field", () => {
  assert.equal(readSavedGatewayResourceId("model-groups", { modelGroup: { id: "group-new" } }), "group-new");
  assert.equal(readSavedGatewayResourceId("credential-sets", { credentialSet: { id: "set-new" } }), "set-new");
  assert.equal(readSavedGatewayResourceId("access-grants", { accessGrant: { id: "grant-new" } }), "grant-new");
  assert.equal(readSavedGatewayResourceId("model-groups", { modelGroup: { id: 1 } }), null);
  assert.equal(readSavedGatewayResourceId("model-groups", { credentialSet: { id: "set-new" } }), null);
  assert.equal(readSavedGatewayResourceId("model-groups", null), null);
});

type SyncInput = Parameters<typeof syncInferenceProviderMatrix>[0];
type Operation =
  | { method: "PATCH" | "POST"; id: string | null; input: GatewayResourceWrite }
  | { method: "DELETE"; id: string; resource: "access-grants" };

const group: GatewayModelGroup = { id: "group-existing", name: "Allowed models", description: "Shared models", status: "active", modelIds: ["model-one"] };
const set: GatewayCredentialSet = { id: "set-existing", name: "Shared credentials", credentialMode: "org", status: "active", configured: true, credentialStatus: "ready" };
const staged = { id: "provider-fixture", modelGroups: [group], credentialSets: [], accessGrants: [] };
const noAccess = { allMembers: false, teamIds: [], memberIds: [] };
const everyone = { ...noAccess, allMembers: true };
const oauth = { oauthClientId: "client-fixture", oauthClientSecret: "secret-fixture" };
const allModelPatch = {
  method: "PATCH", id: group.id,
  input: { resource: "model-groups", body: { name: group.name, description: group.description, allModels: true, status: "active" } },
};

function matrix(overrides: Partial<Omit<SyncInput, "saveResource" | "deleteResource">> = {}, savedGroupId = "group-new") {
  const operations: Operation[] = [];
  const createdIds = { "model-groups": savedGroupId, "credential-sets": "set-new", "access-grants": "grant-new" };
  const input: SyncInput = {
    provider: staged,
    allowAllModels: true,
    modelIds: ["model-one"],
    credentialMode: "org",
    credentialBody: {},
    access: noAccess,
    ...overrides,
    async saveResource(id, input) {
      operations.push({ method: id === null ? "POST" : "PATCH", id, input });
      return id ?? createdIds[input.resource];
    },
    async deleteResource(resource, id) {
      operations.push({ method: "DELETE", id, resource });
    },
  };
  return { operations, sync: () => syncInferenceProviderMatrix(input) };
}

function grant(modelGroupId: string, credentialSetId: string, audience: GatewayAccessGrantWrite["audience"]): Operation {
  return { method: "POST", id: null, input: { resource: "access-grants", body: { audience, modelGroupId, credentialSetId } } };
}

test("staged provider saves member sign-in before granting access to Everyone", async () => {
  const { operations, sync } = matrix({ credentialMode: "member", credentialBody: oauth, access: everyone });
  await sync();
  assert.deepEqual(operations, [
    allModelPatch,
    { method: "POST", id: null, input: { resource: "credential-sets", body: { name: "Default credentials", credentialMode: "member", status: "active", ...oauth } } },
    grant(group.id, "set-new", { type: "organization" }),
  ]);
});

test("staged provider saves a shared key before granting access to Everyone", async () => {
  const credential = { kind: "api_key", secret: "key-fixture" } satisfies NonNullable<SyncInput["credentialBody"]["credential"]>;
  const { operations, sync } = matrix({ credentialBody: { credential }, access: everyone });
  await sync();
  assert.deepEqual(operations, [
    allModelPatch,
    { method: "POST", id: null, input: { resource: "credential-sets", body: { name: "Default credentials", credentialMode: "org", status: "active", credential } } },
    grant(group.id, "set-new", { type: "organization" }),
  ]);
});

test("staged provider without a key or access only updates the model group", async () => {
  const { operations, sync } = matrix();
  await sync();
  assert.deepEqual(operations, [allModelPatch]);
});

test("sharing a staged provider without a key or sign-in fails explicitly", async () => {
  const { operations, sync } = matrix({ access: everyone });
  await assert.rejects(sync(), { message: "Paste a key or configure sign-in before sharing these models." });
  assert.deepEqual(operations, [allModelPatch]);
});

test("a team grant uses the IDs of the newly created group and set", async () => {
  const { operations, sync } = matrix({
    provider: { ...staged, modelGroups: [] },
    credentialMode: "member",
    credentialBody: oauth,
    access: { ...noAccess, teamIds: ["team-fixture", "team-fixture"] },
  });
  await sync();
  assert.deepEqual(operations, [
    { method: "POST", id: null, input: { resource: "model-groups", body: { name: "All Allowed Models", description: null, allModels: true, status: "active" } } },
    { method: "POST", id: null, input: { resource: "credential-sets", body: { name: "Default credentials", credentialMode: "member", status: "active", ...oauth } } },
    grant("group-new", "set-new", { type: "team", teamId: "team-fixture" }),
  ]);
});

test("sharing without a saved model group fails explicitly", async () => {
  const { operations, sync } = matrix({ provider: { ...staged, modelGroups: [] }, access: everyone }, "");
  await assert.rejects(sync(), { message: "Could not save the provider's model group before granting access." });
  assert.deepEqual(operations, [
    { method: "POST", id: null, input: { resource: "model-groups", body: { name: "All Allowed Models", description: null, allModels: true, status: "active" } } },
  ]);
});

test("all-model edits reconcile only the selected group and set's grants", async () => {
  const pair = { modelGroupId: group.id, credentialSetId: set.id };
  const { operations, sync } = matrix({
    provider: {
      ...staged,
      credentialSets: [set],
      accessGrants: [
        { ...pair, id: "grant-keep", audience: { type: "team", teamId: "team-keep" } },
        { ...pair, id: "grant-remove", audience: { type: "team", teamId: "team-remove" } },
        { ...pair, id: "grant-other", credentialSetId: "set-other", audience: { type: "team", teamId: "team-remove" } },
      ],
    },
    access: { ...everyone, teamIds: ["team-keep", "team-add", "team-add"] },
  });
  await sync();
  assert.deepEqual(operations, [
    allModelPatch,
    { method: "DELETE", resource: "access-grants", id: "grant-remove" },
    grant(group.id, set.id, { type: "organization" }),
    grant(group.id, set.id, { type: "team", teamId: "team-add" }),
  ]);
});

test("picked-model edits patch the group with unique model IDs", async () => {
  const { operations, sync } = matrix({
    provider: { ...staged, credentialSets: [set] },
    allowAllModels: false,
    modelIds: ["model-one", "model-two", "model-one"],
  });
  await sync();
  assert.deepEqual(operations, [
    { method: "PATCH", id: group.id, input: { resource: "model-groups", body: { name: group.name, description: group.description, modelIds: ["model-one", "model-two"], status: "active" } } },
  ]);
});
