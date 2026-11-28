import { test, expect } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { cloudMcpProbeHeaders } from "../src/cloud-mcp-health.js";
import { openworkCloudV1RegistrationConfig } from "../src/cloud-coding-worker-proof.js";
import { mapRuntimeMcpToV2 } from "../src/engine-v2-preview.js";
import { inheritedEngineEnv } from "../src/managed-opencode-v2.js";

const worker = "wrk_test";
const token = "activity-test-key";
const idHeader = "x-openwork-cloud-worker-id";
const proofHeader = "x-openwork-cloud-worker-proof";

function withWorkerEnv(workerId: string | undefined, activityToken: string | undefined, run: () => void) {
  const keys = { DEN_WORKER_ID: workerId, DEN_ACTIVITY_HEARTBEAT_TOKEN: activityToken };
  const previous = Object.entries(keys).map(([key]) => [key, process.env[key]] as const);
  const set = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  try {
    for (const [key, value] of Object.entries(keys)) set(key, value);
    run();
  } finally {
    for (const [key, value] of previous) set(key, value);
  }
}

function config(bearer: string) {
  return { type: "remote", url: "https://den.example.test/mcp/agent", enabled: true, oauth: false, headers: { Authorization: `Bearer ${bearer}` } };
}

function registrationPaths(bearer: string) {
  const desired = config(bearer);
  return [openworkCloudV1RegistrationConfig("openwork-cloud", desired), mapRuntimeMcpToV2(desired, "openwork-cloud"), { headers: cloudMcpProbeHeaders(desired.headers.Authorization) }];
}

test("V1, V2 and direct probe sign the exact MCP bearer and recompute after refresh", () => {
  withWorkerEnv(worker, token, () => {
    const proofs = ["mcp-initial", "mcp-refreshed"].map(bearer => {
      const digest = createHash("sha256").update(bearer).digest("hex");
      const proof = `v1.${createHmac("sha256", token).update(`openwork-cloud-worker-proof:v1:${worker}:${digest}`).digest("hex")}`;
      for (const registered of registrationPaths(bearer)) {
        expect(registered?.headers).toMatchObject({ [idHeader]: worker, [proofHeader]: proof });
        expect(JSON.stringify(registered)).not.toContain(token);
      }
      return proof;
    });
    expect(proofs[0]).not.toBe(proofs[1]);
    const other = config("another-mcp");
    expect(openworkCloudV1RegistrationConfig("another-mcp", other)).toBe(other);
    expect(mapRuntimeMcpToV2(other, "another-mcp")?.headers).toEqual(other.headers);
  });
});

test.each([[undefined, token], [worker, undefined], [undefined, undefined]] as const)("missing worker identity or heartbeat leaves registration unchanged", (workerId, activityToken) => {
  withWorkerEnv(workerId, activityToken, () => {
    const desired = config("mcp-bearer");
    const [v1, v2, probe] = registrationPaths("mcp-bearer");
    expect(v1).toBeInstanceOf(Object);
    expect(v1).toEqual(desired);
    expect(v2).toEqual({ type: "remote", url: desired.url, headers: { ...desired.headers, "x-openwork-mcp-client-capabilities": "native-skills-v1" }, protocol: "auto", oauth: false });
    expect(probe?.headers).toEqual({ accept: "application/json, text/event-stream", authorization: desired.headers.Authorization, "content-type": "application/json" });
  });
});

test("the V2 child inherits the surface but not the worker activity token", () => {
  expect(inheritedEngineEnv(undefined, { OPENWORK_RUNTIME_SURFACE: "web", DEN_ACTIVITY_HEARTBEAT_TOKEN: token })).toEqual({ OPENWORK_RUNTIME_SURFACE: "web" });
});
