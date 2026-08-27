import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { liteLlm, liteLlmSandboxName } from "../src/litellm.ts";
import { SkipError } from "../src/needs.ts";
import type { DaytonaExec } from "@openwork/hosts";
import type { LiteLlmUpstreamRequest, Place } from "../src/index.ts";

const MODEL_ID = "openwork-litellm-unit-model";
const PINNED_IMAGE = "ghcr.io/berriai/litellm:v1.97.0@sha256:468c25f35f3e5ec4e414974f00deab93337b1b4d9953cabcfd3722e59415f834";

interface ExecCall {
  args: string[];
  opts?: { input?: string; timeoutMs?: number };
}

interface FakeOptions {
  deleteFailures?: number;
  invalidHealth?: boolean;
  previewOnStderr?: boolean;
  requests?: () => LiteLlmUpstreamRequest[];
}

const daytonaPlace: Place = {
  kind: "daytona",
  host() {
    return undefined;
  },
  async db() {
    throw new Error("unused test database");
  },
  async exposeMock(handle) {
    return new URL(handle.url);
  },
  denBase() {
    return { kind: "daytona", ref: "unit-test" };
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function remoteScript(args: string[]): string {
  const wrapped = args[3] ?? "";
  const prefix = "bash -lc '";
  return wrapped.startsWith(prefix) && wrapped.endsWith("'")
    ? wrapped.slice(prefix.length, -1)
    : "";
}

function makeFake(options: FakeOptions = {}): {
  calls: ExecCall[];
  exec: DaytonaExec;
  fetchImpl: typeof fetch;
  dockerfile(): string;
  masterKey(): string;
  upstreamKey(): string;
  controlKey(): string;
  modelInfo(): Record<string, unknown>;
} {
  const calls: ExecCall[] = [];
  const uploads = new Map<string, string>();
  let dockerfile = "";
  let masterKey = "";
  let upstreamKey = "";
  let controlKey = "";
  let modelInfo: Record<string, unknown> = {};
  let deleteAttempts = 0;
  const exec: DaytonaExec = async (args, opts) => {
    calls.push({ args: [...args], opts });
    if (args[0] === "create") {
      const dockerfileIndex = args.indexOf("--dockerfile") + 1;
      dockerfile = await readFile(args[dockerfileIndex] ?? "", "utf8");
      return { stdout: "created\n", stderr: "", code: 0 };
    }
    if (args[0] === "preview-url") {
      const port = args[args.indexOf("-p") + 1] ?? "";
      if (options.previewOnStderr) {
        return { stdout: "", stderr: "Upgrade at https://updates.example.test\n", code: 0 };
      }
      return { stdout: `Preview URL: https://port-${port}.example.test\n`, stderr: "", code: 0 };
    }
    if (args[0] === "delete") {
      deleteAttempts += 1;
      if (deleteAttempts <= (options.deleteFailures ?? 0)) {
        return { stdout: "transient deletion failure\n", stderr: "", code: 1 };
      }
      return { stdout: "deleted\n", stderr: "", code: 0 };
    }
    if (args[0] !== "exec") return { stdout: "", stderr: "", code: 0 };

    const script = remoteScript(args);
    const chunk = /^printf %s ([A-Za-z0-9+/=]+) >> (\/tmp\/[A-Za-z0-9._/-]+\.b64)$/.exec(script);
    if (chunk?.[1] && chunk[2]) uploads.set(chunk[2], `${uploads.get(chunk[2]) ?? ""}${chunk[1]}`);
    const finalize = /base64 -d (\/tmp\/[A-Za-z0-9._/-]+\.b64) > (\/tmp\/[A-Za-z0-9._/-]+)/.exec(script);
    if (finalize?.[1] && finalize[2]) {
      const content = Buffer.from(uploads.get(finalize[1]) ?? "", "base64").toString("utf8");
      if (finalize[2].endsWith("config.json")) {
        const parsed: unknown = JSON.parse(content);
        const general = isRecord(parsed) && isRecord(parsed.general_settings) ? parsed.general_settings : {};
        const models = isRecord(parsed) && Array.isArray(parsed.model_list) ? parsed.model_list.filter(isRecord) : [];
        const params = models[0] && isRecord(models[0].litellm_params) ? models[0].litellm_params : {};
        masterKey = typeof general.master_key === "string" ? general.master_key : "";
        upstreamKey = typeof params.api_key === "string" ? params.api_key : "";
        modelInfo = models[0] && isRecord(models[0].model_info) ? models[0].model_info : {};
      }
    }
    if (script.includes("tail -80")) {
      return { stdout: `${masterKey}\n${upstreamKey}\n${controlKey}\n`, stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/__openwork_litellm/health") {
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      controlKey = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
      return Response.json(options.invalidHealth ? { ok: false, sequence: 0 } : { ok: true, sequence: 3 });
    }
    if (url.pathname === "/__openwork_litellm/requests") {
      return Response.json({ sequence: 3, requests: options.requests?.() ?? [] });
    }
    if (url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: MODEL_ID }] });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };
  return {
    calls,
    exec,
    fetchImpl,
    dockerfile: () => dockerfile,
    masterKey: () => masterKey,
    upstreamKey: () => upstreamKey,
    controlKey: () => controlKey,
    modelInfo: () => modelInfo,
  };
}

test("LiteLLM Daytona sandbox names are safe and unique", () => {
  const first = liteLlmSandboxName();
  const second = liteLlmSandboxName();

  assert.match(first, /^openwork-litellm-eval-[0-9]+-[a-z0-9]+-[0-9a-f]{8}$/);
  assert.notEqual(first, second);
});

test("LiteLLM database mode skips Daytona placement before provisioning", async () => {
  const fake = makeFake();
  await assert.rejects(
    liteLlm({
      place: daytonaPlace,
      modelId: MODEL_ID,
      reply: "deterministic reply",
      database: true,
      daytonaExec: fake.exec,
      fetchImpl: fake.fetchImpl,
    }),
    (error: unknown) => error instanceof SkipError
      && error.reason === "LiteLLM database mode currently requires docker placement",
  );
  assert.equal(fake.calls.length, 0);
});

test("Daytona LiteLLM pins its image, verifies bounded uploads, exposes both ports, and uses sequence cursors", async () => {
  let upstreamFingerprint = "";
  const fake = makeFake({
    requests: () => [
      { sequence: 1, model: "older", tokenId: "older-token", bodyText: "older" },
      { sequence: 2, model: MODEL_ID, tokenId: upstreamFingerprint, bodyText: "probe" },
      { sequence: 3, model: MODEL_ID, tokenId: "other-token", bodyText: "chat" },
    ],
  });
  const gateway = await liteLlm({
    place: daytonaPlace,
    modelId: MODEL_ID,
    reply: "deterministic reply",
    maxInputTokens: 96_000,
    maxOutputTokens: 12_345,
    daytonaExec: fake.exec,
    fetchImpl: fake.fetchImpl,
  });
  upstreamFingerprint = gateway.tokenId(gateway.upstreamKey);

  const create = fake.calls.find((call) => call.args[0] === "create");
  assert(create);
  assert.match(fake.dockerfile(), new RegExp(`^FROM ${PINNED_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.match(fake.dockerfile(), /^ENTRYPOINT \["\/usr\/bin\/bash", "-lc"\]$/m);
  assert.match(fake.dockerfile(), /^CMD \["sleep infinity"\]$/m);
  for (const [flag, value] of [
    ["--auto-stop", "60"],
    ["--auto-delete", "0"],
    ["--ttl", "120"],
    ["--target", "us"],
  ]) {
    assert.equal(create.args[create.args.indexOf(flag) + 1], value);
  }
  assert(create.args.includes("--dockerfile"));
  assert(create.args.includes("--public"));

  const launchIndex = fake.calls.findIndex((call) => remoteScript(call.args).includes("/app/.venv/bin/litellm"));
  assert(launchIndex > 0);
  const uploadCalls = fake.calls
    .map((call, index) => ({ index, script: remoteScript(call.args) }))
    .filter(({ script }) => script.includes(".b64"));
  assert(uploadCalls.length > 4);
  assert(uploadCalls.every(({ index }) => index < launchIndex));
  const chunks = uploadCalls.flatMap(({ script }) => {
    const match = /^printf %s ([A-Za-z0-9+/=]+) >> /.exec(script);
    return match?.[1] ? [match[1]] : [];
  });
  assert(chunks.length >= 2);
  assert(chunks.every((chunk) => chunk.length <= 8 * 1_024));
  const finalizers = uploadCalls.filter(({ script }) => script.includes("actual_bytes=$(wc -c"));
  assert.equal(finalizers.length, 2);
  assert(finalizers.every(({ script }) => script.includes('test "$decode_status" -eq 0 && test "$actual_bytes"')));
  assert(finalizers.every(({ script }) => /test "\$actual_bytes" -eq [1-9][0-9]*/.test(script)));

  const previews = fake.calls.filter((call) => call.args[0] === "preview-url");
  assert.deepEqual(
    previews.map((call) => ({
      port: call.args[call.args.indexOf("-p") + 1],
      expires: call.args[call.args.indexOf("--expires") + 1],
    })),
    [{ port: "4000", expires: "7200" }, { port: "4001", expires: "7200" }],
  );
  assert.equal(gateway.baseUrl, "https://port-4000.example.test/v1");
  assert.deepEqual(fake.modelInfo(), {
    max_input_tokens: 96_000,
    max_output_tokens: 12_345,
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: false,
    supports_response_schema: true,
    supported_openai_params: ["temperature", "tools", "response_format"],
  });
  assert.equal(await gateway.checkpoint(), 3);
  assert.deepEqual((await gateway.upstreamRequests({ after: 1 })).map((request) => request.sequence), [2, 3]);
  assert.equal((await gateway.waitForUpstreamRequest({
    after: 1,
    model: MODEL_ID,
    key: gateway.upstreamKey,
    timeoutMs: 1_000,
  })).sequence, 2);

  await gateway[Symbol.asyncDispose]();
  await gateway[Symbol.asyncDispose]();
  const deletions = fake.calls.filter((call) => call.args[0] === "delete");
  assert.equal(deletions.length, 1);
  assert.equal(deletions[0]?.opts?.input, "y\n");
});

test("Daytona LiteLLM redacts every key and deletes its sandbox after startup failure", async () => {
  const fake = makeFake({ invalidHealth: true });
  let failure: unknown;
  try {
    await liteLlm({
      place: daytonaPlace,
      modelId: MODEL_ID,
      reply: "deterministic reply",
      daytonaExec: fake.exec,
      fetchImpl: fake.fetchImpl,
    });
  } catch (error) {
    failure = error;
  }

  assert(failure instanceof Error);
  for (const secret of [fake.masterKey(), fake.upstreamKey(), fake.controlKey()]) {
    assert(secret.length > 20);
    assert(!failure.message.includes(secret));
  }
  assert.match(failure.message, /\[REDACTED\]/);
  assert.match(failure.message, /Daytona logs/);
  assert.equal(fake.calls.filter((call) => call.args[0] === "delete").length, 1);
});

test("Daytona LiteLLM ignores unrelated HTTPS URLs on CLI stderr", async () => {
  const fake = makeFake({ previewOnStderr: true });

  await assert.rejects(
    liteLlm({
      place: daytonaPlace,
      modelId: MODEL_ID,
      reply: "deterministic reply",
      daytonaExec: fake.exec,
      fetchImpl: fake.fetchImpl,
    }),
    /did not return an HTTPS URL/,
  );
  assert.equal(fake.calls.filter((call) => call.args[0] === "delete").length, 1);
});

test("Daytona LiteLLM disposal retries a transient sandbox deletion failure", async () => {
  const fake = makeFake({ deleteFailures: 1 });
  const gateway = await liteLlm({
    place: daytonaPlace,
    modelId: MODEL_ID,
    reply: "deterministic reply",
    daytonaExec: fake.exec,
    fetchImpl: fake.fetchImpl,
  });

  await assert.rejects(gateway[Symbol.asyncDispose](), /Sandbox deletion gate failed/);
  await gateway[Symbol.asyncDispose]();
  assert.equal(fake.calls.filter((call) => call.args[0] === "delete").length, 2);
});
