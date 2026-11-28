import assert from "node:assert/strict";
import test from "node:test";
import { artifactOpenUrl, readArtifactLink } from "./artifact-link";

const id = `cob_${"0".repeat(26)}`;
const org = `org_${"1".repeat(26)}`;
const denApiUrl = "https://api.example.test";
const serverPath = `/mcp/agent/connections/${id}`;

test("builds an artifact URL on the configured API with the organization ID", () => {
  assert.deepEqual(readArtifactLink({ id, org }), { id, org });
  assert.equal(artifactOpenUrl({ denApiUrl, id, org }), `${denApiUrl}${serverPath}?org=${org}`);
});

test("preserves the API path prefix and strips trailing slashes", () => {
  assert.equal(artifactOpenUrl({ denApiUrl: `${denApiUrl}/`, id }), `${denApiUrl}${serverPath}`);
  assert.equal(artifactOpenUrl({ denApiUrl: `${denApiUrl}/den/api///`, id }), `${denApiUrl}/den/api${serverPath}`);
});

test("rejects missing, malformed and ambiguous artifact IDs", () => {
  for (const badId of [undefined, "", "//other.example.test", `${id}/../`, `cob_8${"0".repeat(25)}`, org, [id, id]]) {
    assert.equal(readArtifactLink({ id: badId, org }), null);
    assert.equal(artifactOpenUrl({ denApiUrl, id: badId, org }), null);
  }
});

test("drops invalid and ambiguous organization IDs without dropping the artifact", () => {
  for (const badOrg of [undefined, "", "https://other.example.test", id, `org_8${"0".repeat(25)}`, `${org}&next=https://other.example.test`, [org, org]]) {
    assert.equal(artifactOpenUrl({ denApiUrl, id, org: badOrg }), `${denApiUrl}${serverPath}`);
  }
});

test("requires a usable absolute HTTP(S) API URL", () => {
  for (const url of ["", "/api/den", "//api.example.test", "javascript:alert(1)", "https://name:password@api.example.test"]) {
    assert.equal(artifactOpenUrl({ denApiUrl: url, id, org }), null);
  }
  assert.equal(artifactOpenUrl({ denApiUrl: "http://localhost:3000", id }), `http://localhost:3000${serverPath}`);
});
