import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { needs, test } from "@openwork/testkit";

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
const runner = `import json, sys
sys.path.insert(0, sys.argv[1])
from mcp_proof_redaction import sanitize
payload = json.load(sys.stdin)
print(json.dumps(sanitize(payload['value'], payload['secrets'])))`;

function runPython(source: string, input: unknown): unknown {
  needs({ commands: ["python3"], placement: "local" });
  const result = spawnSync("python3", ["-B", "-c", source, fixtures], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

function sanitize(value: unknown, secrets: string[] = []) {
  return runPython(runner, { value, secrets });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected sanitized object");
  return value;
}

test("proof redaction removes unknown structured credentials without erasing public metadata", () => {
  const aliases = ["apiKey", "api-key", "accessToken", "access_token", "refreshToken", "refresh_token", "idToken", "sessionToken", "clientSecret", "client_secret", "oauthClientSecret", "registration_access_token", "key", "password", "bootstrapGrant", "grant", "codeVerifier", "state", "start"];
  const credentials = Object.fromEntries(aliases.map((key) => [key, `unknown-sentinel-${key}`]));
  const output = record(sanitize({ llmProvider: credentials, id: "synthetic-provider", code: 200, connected: false, tokenId: "0123456789abcdef", optional: null }));
  expect(output.llmProvider).toEqual(Object.fromEntries(aliases.map((key) => [key, "[REDACTED]"])));
  expect(JSON.stringify(output)).not.toContain("unknown-sentinel");
  expect(output).toMatchObject({ id: "synthetic-provider", code: 200, connected: false, tokenId: "0123456789abcdef", optional: null });
});

test("proof redaction recognizes map, name-value and folded raw credential headers", () => {
  const value = {
    request: { headers: [
      { name: "Authorization", value: "Bearer unknown-list-sentinel" },
      { name: "SET-COOKIE", value: "session=unknown-cookie-sentinel", redacted: false },
      { name: "Content-Type", value: "application/json" },
    ] },
    response: { headers: { "x-api-key": "unknown-map-sentinel", "Set-Auth-Token": ["unknown-array-sentinel"], "Content-Type": "application/json" } },
    raw: "HTTP/1.1 200 OK\r\nSet-Cookie: unknown-raw-sentinel\r\n\tunknown-folded-sentinel\r\nSet-Auth-Token: unknown-auth-sentinel\r\nContent-Type: application/json\r\n",
    unrelated: { name: "Authorization", value: "not-a-header" },
  };
  const output = record(sanitize(value));
  expect(JSON.stringify(output)).not.toContain("unknown-");
  expect(record(output.request).headers).toEqual([
    { name: "Authorization", value: "[REDACTED]" },
    { name: "SET-COOKIE", value: "[REDACTED]", redacted: false },
    { name: "Content-Type", value: "application/json" },
  ]);
  expect(record(output.response).headers).toEqual({ "x-api-key": "[REDACTED]", "Set-Auth-Token": ["[REDACTED]"], "Content-Type": "application/json" });
  expect(output.raw).toContain("Content-Type: application/json");
  expect(output.unrelated).toEqual(value.unrelated);
});

test("proof redaction covers signed OAuth URLs, encoded parameters, userinfo and embedded JSON", () => {
  const output = record(sanitize({
    authorizeUrl: "https://fixture.example/authorize?%73tate=unknown-state-sentinel&client_id=synthetic-client&code=unknown-code-sentinel",
    location: "Location: https://fixture.example/callback#access_token=unknown-fragment-sentinel",
    redirect: "https://fixture.example/?redirect_uri=https%3A%2F%2Ffixture.example%2Fcallback%3Fstate%3Dunknown-nested-sentinel",
    url: "https://synthetic-user:unknown-password-sentinel@fixture.example/public",
    body: JSON.stringify({ accessToken: "unknown-json-sentinel", inspection: { request: { headers: [{ name: "Authorization", value: "Bearer unknown-json-header-sentinel" }] } }, nonce: "safe-nonce" }),
  }));
  expect(JSON.stringify(output)).not.toContain("unknown-");
  expect(output.authorizeUrl).toBe("https://fixture.example/authorize?%73tate=[REDACTED]&client_id=synthetic-client&code=[REDACTED]");
  expect(output.location).toBe("Location: https://fixture.example/callback#access_token=[REDACTED]");
  expect(output.redirect).toBe("https://fixture.example/?redirect_uri=https%3A%2F%2Ffixture.example%2Fcallback%3Fstate%3D%5BREDACTED%5D");
  expect(output.url).toBe("https://[REDACTED]@fixture.example/public");
  expect(typeof output.body).toBe("string");
  expect(output.body).toContain("safe-nonce");
});

test("proof redaction preserves schema declarations and example header shapes", () => {
  const schema = {
    openapi: "3.1.0", paths: {}, components: { schemas: { Credentials: {
      type: "object", required: ["apiKey", "state"], properties: {
        apiKey: { type: "string" }, state: { type: "string", enum: ["ready", "missing"] },
        headers: { type: "array", items: { type: "object", properties: { name: { type: "string" }, value: { type: "string" } } } },
      },
      example: { headers: [{ name: "Authorization", value: "schema-placeholder" }], state: "schema-placeholder" },
    } } },
  };
  expect(sanitize(schema)).toEqual(schema);
  expect(sanitize({ schema: schema.components.schemas.Credentials })).toEqual({ schema: schema.components.schemas.Credentials });
});

test("proof redaction retains known replacements, synthetic identities and input immutability", () => {
  const value = { message: "configured-sentinel-long configured-sentinel encoded%2Fsentinel", email: "person@synthetic.invalid", synthetic: "release-admin@example.com", name: "Synthetic Tenant" };
  const before = structuredClone(value);
  const output = sanitize(value, ["", "configured-sentinel", "configured-sentinel-long", "encoded/sentinel"]);
  expect(output).toEqual({ message: "[REDACTED] [REDACTED] [REDACTED]", email: "[REDACTED_EMAIL]", synthetic: "release-admin@example.com", name: "Synthetic Tenant" });
  expect(value).toEqual(before);
});

test("all three exporters delegate redaction without executing their private-state producers", () => {
  const source = `import ast, json, pathlib, sys
sys.path.insert(0, sys.argv[1])
payload = json.load(sys.stdin)
outputs = {}
for name in ['mcp-put-release-client.py', 'mcp-put-release-tenant.py', 'mcp-post-deploy-release.py']:
    tree = ast.parse((pathlib.Path(sys.argv[1]) / name).read_text())
    exporter = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'export')
    cleaner = next(node for node in exporter.body if isinstance(node, ast.FunctionDef) and node.name == 'clean')
    namespace = {'hidden': [], 'secrets': []}
    exec(compile(ast.Module(body=[cleaner], type_ignores=[]), name, 'exec'), namespace)
    outputs[name] = namespace['clean'](payload)
print(json.dumps(outputs))`;
  const output = record(runPython(source, { response: { headers: [{ name: "Authorization", value: "Bearer unknown-exporter-sentinel" }], body: { llmProvider: { apiKey: "unknown-provider-sentinel" } } } }));
  expect(Object.keys(output).sort()).toEqual(["mcp-post-deploy-release.py", "mcp-put-release-client.py", "mcp-put-release-tenant.py"]);
  for (const value of Object.values(output)) expect(value).toEqual({ response: { headers: [{ name: "Authorization", value: "[REDACTED]" }], body: { llmProvider: { apiKey: "[REDACTED]" } } } });
  expect(JSON.stringify(output)).not.toContain("unknown-");
});
