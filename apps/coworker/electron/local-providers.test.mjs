import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  SignInImportError,
  codexAuthFromFile,
  codexAuthPath,
  codexSignInMode,
  copilotAuthFromFile,
  copilotSignedIn,
  detectLocalProviders,
  jwtExpiryMs,
  listOpenAiCompatibleModels,
  localServerProviderPatch,
  normalizeOpenAiCompatibleAddress,
  openAiCompatibleProviderConfig,
  opencodeAuthPath,
} from "./local-providers.mjs";

// Every fixture value is plainly fake; nothing here resembles a real credential.
const FAKE_REFRESH = "fixture-refresh-token-not-real";
const FAKE_ACCOUNT = "fixture-account-id";
const FAKE_GITHUB_TOKEN = "fixture-github-token-not-real";

function fakeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

async function tempHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "coworker-local-providers-"));
  return { home, [Symbol.asyncDispose]: () => rm(home, { recursive: true, force: true }) };
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** A fetch stub: known URLs answer at once; anything else never answers until the signal aborts. */
function fetchStub(routes) {
  return (url, init) => {
    const route = routes[String(url)];
    if (route) return Promise.resolve(new Response(JSON.stringify(route), { status: 200, headers: { "content-type": "application/json" } }));
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };
}

const noKeychain = async () => false;
const quietEnv = { XDG_CONFIG_HOME: "", XDG_DATA_HOME: "" };

test("an empty Mac is simply empty: no findings, no errors, and bounded probes", async () => {
  await using fixture = await tempHome();
  await mkdir(path.join(fixture.home, "Applications", "ChatGPT.app"), { recursive: true });
  const startedAt = Date.now();
  const result = await detectLocalProviders({
    env: quietEnv,
    homeDir: fixture.home,
    platform: "darwin",
    fetchImpl: fetchStub({}),
    timeoutMs: 100,
    keychainProbe: noKeychain,
  });
  assert.deepEqual(result.found, []);
  assert.ok(typeof result.checkedAt === "number");
  assert.ok(Date.now() - startedAt < 1_500, "silent ports are given up on quickly");
});

test("a Codex ChatGPT sign-in is found by shape only and maps to the openai provider", async () => {
  await using fixture = await tempHome();
  const logged = [];
  await writeJson(path.join(fixture.home, ".codex", "auth.json"), {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: fakeJwt({ sub: "x" }), access_token: fakeJwt({ exp: 1_900_000_000 }), refresh_token: FAKE_REFRESH, account_id: FAKE_ACCOUNT },
    last_refresh: "2026-09-01T00:00:00.000Z",
  });
  const result = await detectLocalProviders({ env: quietEnv, homeDir: fixture.home, platform: "linux", fetchImpl: fetchStub({}), timeoutMs: 50, keychainProbe: noKeychain, log: (line) => logged.push(line) });
  assert.deepEqual(result.found.map((finding) => [finding.id, finding.providerId, finding.how]), [["codex", "openai", "import"]]);
  assert.equal(result.found[0].label, "ChatGPT (signed in with Codex)");
  assert.equal(result.found[0].credentialKind, "chatgpt-oauth");
  assert.doesNotMatch(result.found[0].detail, /subscription|Plus|Pro|valid/i);
  const serialized = JSON.stringify(result) + logged.join("\n");
  assert.ok(!serialized.includes(FAKE_REFRESH) && !serialized.includes(FAKE_ACCOUNT), "no secret value leaves the detector");
  assert.ok(!serialized.includes(".codex"), "no path to a secret file leaves the detector");
});

test("CODEX_HOME moves the Codex sign-in, and a key-mode Codex is offered as an OpenAI key", async () => {
  await using fixture = await tempHome();
  const codexHome = path.join(fixture.home, "elsewhere", "codex");
  await writeJson(path.join(codexHome, "auth.json"), { auth_mode: "apikey", OPENAI_API_KEY: "fixture-openai-key-not-real", tokens: null });
  assert.equal(codexAuthPath({ CODEX_HOME: codexHome }, fixture.home), path.join(codexHome, "auth.json"));
  const result = await detectLocalProviders({ env: { ...quietEnv, CODEX_HOME: codexHome }, homeDir: fixture.home, platform: "linux", fetchImpl: fetchStub({}), timeoutMs: 50, keychainProbe: noKeychain });
  assert.equal(result.found[0]?.label, "OpenAI key (saved by Codex)");
  assert.equal(result.found[0]?.how, "import");
  assert.equal(result.found[0]?.credentialKind, "api-key");
  assert.doesNotMatch(JSON.stringify(result), /ChatGPT|fixture-openai-key-not-real/);
});

test("a malformed or signed-out Codex file counts as not found", async () => {
  await using fixture = await tempHome();
  await writeFile(path.join(fixture.home, ".codex", "auth.json").replace("/.codex/auth.json", "/placeholder"), "", "utf8").catch(() => undefined);
  await mkdir(path.join(fixture.home, ".codex"), { recursive: true });
  await writeFile(path.join(fixture.home, ".codex", "auth.json"), "{ not json", "utf8");
  let result = await detectLocalProviders({ env: quietEnv, homeDir: fixture.home, platform: "linux", fetchImpl: fetchStub({}), timeoutMs: 50, keychainProbe: noKeychain });
  assert.deepEqual(result.found, []);
  await writeJson(path.join(fixture.home, ".codex", "auth.json"), { auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: "", refresh_token: "" } });
  result = await detectLocalProviders({ env: quietEnv, homeDir: fixture.home, platform: "linux", fetchImpl: fetchStub({}), timeoutMs: 50, keychainProbe: noKeychain });
  assert.deepEqual(result.found, []);
  assert.equal(codexSignInMode({ tokens: { access_token: "a", refresh_token: "b" } }), "chatgpt");
  assert.equal(codexSignInMode({ OPENAI_API_KEY: "k" }), "apikey");
  assert.equal(codexSignInMode(null), null);
  for (const tokens of [null, [], {}, { access_token: "fixture-access" }, { refresh_token: FAKE_REFRESH }, { access_token: 1, refresh_token: FAKE_REFRESH }]) {
    assert.equal(codexSignInMode({ auth_mode: "chatgpt", tokens }), null);
  }
});

test("codexAuthFromFile yields the engine's own credential shape and refuses a missing sign-in", () => {
  const access = fakeJwt({ exp: 1_800_000_000 });
  assert.deepEqual(
    codexAuthFromFile({ tokens: { access_token: access, refresh_token: FAKE_REFRESH, account_id: FAKE_ACCOUNT } }),
    { type: "oauth", refresh: FAKE_REFRESH, access, expires: 1_800_000_000_000, accountId: FAKE_ACCOUNT },
  );
  assert.deepEqual(codexAuthFromFile({ OPENAI_API_KEY: " fixture-openai-key-not-real " }), { type: "api", key: "fixture-openai-key-not-real" });
  assert.throws(() => codexAuthFromFile({ tokens: {} }), (error) => error instanceof SignInImportError && error.code === "missing");
  assert.equal(jwtExpiryMs("not-a-jwt"), 0);
  assert.equal(jwtExpiryMs(`${Buffer.from("{}").toString("base64url")}.${Buffer.from("{}").toString("base64url")}.x`), 0);
});

test("Claude Code credentials are detected but not offered for import, from a file or the macOS keychain", async () => {
  await using fixture = await tempHome();
  let probed = "";
  const viaKeychain = await detectLocalProviders({
    env: quietEnv,
    homeDir: fixture.home,
    platform: "darwin",
    fetchImpl: fetchStub({}),
    timeoutMs: 50,
    keychainProbe: async (service) => {
      probed = service;
      return true;
    },
  });
  assert.equal(probed, "Claude Code-credentials");
  assert.deepEqual(viaKeychain.found.map((finding) => [finding.id, finding.how, finding.providerId]), [["claude-code", "unavailable", "anthropic"]]);
  assert.equal(viaKeychain.found[0].label, "Claude Code credentials found");
  assert.equal(viaKeychain.found[0].reason, "These credentials cannot be imported into Open Coworker. Add an Anthropic API key instead.");

  await writeJson(path.join(fixture.home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "fixture-claude-token-not-real" } });
  const viaFile = await detectLocalProviders({ env: quietEnv, homeDir: fixture.home, platform: "linux", fetchImpl: fetchStub({}), timeoutMs: 50, keychainProbe: async () => { throw new Error("no keychain on linux"); } });
  assert.equal(viaFile.found[0]?.id, "claude-code");
  assert.ok(!JSON.stringify(viaFile).includes("fixture-claude-token"));
  await writeJson(path.join(fixture.home, ".claude", ".credentials.json"), {});
  const emptyFile = await detectLocalProviders({ env: quietEnv, homeDir: fixture.home, platform: "linux", fetchImpl: fetchStub({}), timeoutMs: 50, keychainProbe: noKeychain });
  assert.deepEqual(emptyFile.found, viaKeychain.found, "presence never claims a validated sign-in, even for an empty object");
});

test("a Copilot hosts or apps file under XDG_CONFIG_HOME is found and imports as the engine's refresh token", async () => {
  await using fixture = await tempHome();
  const configHome = path.join(fixture.home, "xdg-config");
  await writeJson(path.join(configHome, "github-copilot", "apps.json"), { "github.com:Iv1.fixture": { user: "octocat", oauth_token: FAKE_GITHUB_TOKEN, githubAppId: "Iv1.fixture" } });
  const result = await detectLocalProviders({ env: { ...quietEnv, XDG_CONFIG_HOME: configHome }, homeDir: fixture.home, platform: "linux", fetchImpl: fetchStub({}), timeoutMs: 50, keychainProbe: noKeychain });
  assert.deepEqual(result.found.map((finding) => [finding.id, finding.providerId, finding.how]), [["copilot", "github-copilot", "import"]]);
  assert.ok(!JSON.stringify(result).includes(FAKE_GITHUB_TOKEN));
  assert.equal(copilotSignedIn({ "github.com": { user: "octocat", oauth_token: FAKE_GITHUB_TOKEN } }), true);
  assert.equal(copilotSignedIn({ "ghe.example.com": { oauth_token: "x" } }), false);
  for (const host of ["github.com.attacker.invalid", "github.com@attacker.invalid", "github.com/attacker", "ghe.example.com"]) {
    const credentials = { [host]: { oauth_token: FAKE_GITHUB_TOKEN } };
    assert.equal(copilotSignedIn(credentials), false);
    assert.throws(() => copilotAuthFromFile(credentials), SignInImportError);
  }
  assert.deepEqual(copilotAuthFromFile({ "github.com": { oauth_token: FAKE_GITHUB_TOKEN } }), { type: "oauth", refresh: FAKE_GITHUB_TOKEN, access: "", expires: 0 });
  assert.throws(() => copilotAuthFromFile({}), SignInImportError);
});

test("providers already in OpenCode's shared store are listed by id, without account-managed ones", async () => {
  await using fixture = await tempHome();
  const dataHome = path.join(fixture.home, "xdg-data");
  await writeJson(opencodeAuthPath({ XDG_DATA_HOME: dataHome }, fixture.home), {
    openrouter: { type: "api", key: "fixture-openrouter-key-not-real" },
    lpr_01org: { type: "api", key: "fixture-org-key-not-real" },
    openwork: { type: "api", key: "fixture-openwork-key-not-real" },
    anthropic: { type: "api", key: "fixture-anthropic-key-not-real" },
  });
  const result = await detectLocalProviders({ env: { ...quietEnv, XDG_DATA_HOME: dataHome }, homeDir: fixture.home, platform: "linux", fetchImpl: fetchStub({}), timeoutMs: 50, keychainProbe: noKeychain });
  assert.deepEqual(result.found.map((finding) => [finding.id, finding.how]), [["opencode:anthropic", "in-use"], ["opencode:openrouter", "in-use"]]);
  assert.ok(!JSON.stringify(result).includes("not-real"));
  assert.ok(result.found.every((finding) => finding.credentialKind === "api-key"));
});

test("OpenCode ChatGPT detection requires a complete OpenAI OAuth shape, not a key or an unknown auth entry", async () => {
  await using fixture = await tempHome();
  const oauth = { type: "oauth", access: "fixture-access-not-real", refresh: FAKE_REFRESH, expires: 0, accountId: FAKE_ACCOUNT };
  const cases = [
    [oauth, "chatgpt-oauth"], // Expiry is not subscription validity; the engine must check availability.
    [{ ...oauth, type: "api", key: "fixture-openai-key-not-real" }, "api-key"],
    [{ ...oauth, type: "typeapi" }, "unknown"],
    [{ ...oauth, type: "unknown" }, "unknown"],
    [{ ...oauth, access: "" }, "unknown"],
    [{ ...oauth, refresh: " " }, "unknown"],
    [{ ...oauth, expires: "0" }, "unknown"],
    [{ ...oauth, expires: -1 }, "unknown"],
    [{ type: "oauth", access: oauth.access, refresh: oauth.refresh }, "unknown"],
    [{ type: "api", key: "" }, "unknown"],
    [{}, "unknown"],
    [null, "unknown"],
    [[oauth], "unknown"],
  ];
  const file = opencodeAuthPath(quietEnv, fixture.home);
  const options = { env: quietEnv, homeDir: fixture.home, platform: "linux", fetchImpl: async () => { throw new Error("offline fixture"); }, keychainProbe: noKeychain };
  for (const [auth, credentialKind] of cases) {
    await writeJson(file, { openai: auth, anthropic: oauth });
    const logged = [];
    const result = await detectLocalProviders({ ...options, log: (line) => logged.push(line) });
    const openai = result.found.find((finding) => finding.providerId === "openai");
    assert.equal(openai?.credentialKind, credentialKind);
    assert.equal(openai?.label.includes("ChatGPT"), credentialKind === "chatgpt-oauth");
    assert.equal(result.found.find((finding) => finding.providerId === "anthropic")?.credentialKind, "unknown");
    assert.doesNotMatch(JSON.stringify(result) + logged.join("\n"), /fixture-|subscription|\.json/);
  }
  await writeFile(file, "{ not json", "utf8");
  assert.deepEqual((await detectLocalProviders(options)).found, []);
});

test("API keys are reported by name only, once per provider, and blanks do not count", async () => {
  await using fixture = await tempHome();
  const result = await detectLocalProviders({
    env: { ...quietEnv, OPENAI_API_KEY: "fixture-openai-key-not-real", GEMINI_API_KEY: "fixture-gemini-key-not-real", GOOGLE_API_KEY: "fixture-google-key-not-real", ANTHROPIC_API_KEY: "   " },
    homeDir: fixture.home,
    platform: "linux",
    fetchImpl: fetchStub({}),
    timeoutMs: 50,
    keychainProbe: noKeychain,
  });
  assert.deepEqual(result.found.map((finding) => [finding.id, finding.providerId, finding.how, finding.envName]), [
    ["env:OPENAI_API_KEY", "openai", "in-use", "OPENAI_API_KEY"],
    ["env:GEMINI_API_KEY", "google", "in-use", "GEMINI_API_KEY"],
  ]);
  assert.ok(!JSON.stringify(result).includes("not-real"), "key values never appear");
  assert.ok(result.found.every((finding) => finding.credentialKind === "api-key"));
  assert.doesNotMatch(JSON.stringify(result), /ChatGPT/);
});

test("server provider config rejects invalid providers or empty models and contains no key", () => {
  assert.throws(() => localServerProviderPatch({ providerId: "openai", address: "http://x" }), /not a local model server/);
  assert.throws(() => openAiCompatibleProviderConfig({ name: "x", address: "http://x", models: [] }), /at least one model/);
  assert.ok(!JSON.stringify(openAiCompatibleProviderConfig({ name: "n", address: "http://x/v1", models: ["m"] })).includes("key"));
});

test("a typed address is normalised to an origin plus /v1, and its models are listed with an optional key", async () => {
  assert.equal(normalizeOpenAiCompatibleAddress("127.0.0.1:1234"), "http://127.0.0.1:1234/v1");
  assert.equal(normalizeOpenAiCompatibleAddress("http://127.0.0.1:1234/"), "http://127.0.0.1:1234/v1");
  assert.equal(normalizeOpenAiCompatibleAddress("https://ai.example.com/v1/"), "https://ai.example.com/v1");
  assert.equal(normalizeOpenAiCompatibleAddress("https://ai.example.com/openai/v1?x=1"), "https://ai.example.com/openai/v1");
  assert.throws(() => normalizeOpenAiCompatibleAddress(""), /Enter the server address/);
  assert.throws(() => normalizeOpenAiCompatibleAddress("ftp://x"), /http/);
  const seen = [];
  const listed = await listOpenAiCompatibleModels("127.0.0.1:1234", " fixture-key ", {
    fetchImpl: (url, init) => {
      seen.push([String(url), init?.headers?.Authorization ?? ""]);
      return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }, { id: "m1" }] }), { status: 200 }));
    },
  });
  assert.deepEqual(listed, { address: "http://127.0.0.1:1234/v1", models: ["m1", "m2"] });
  assert.deepEqual(seen, [["http://127.0.0.1:1234/v1/models", "Bearer fixture-key"]]);
  await assert.rejects(
    listOpenAiCompatibleModels("http://127.0.0.1:1", "", { fetchImpl: () => Promise.resolve(new Response("", { status: 401 })) }),
    /did not accept the key/,
  );
  await assert.rejects(
    listOpenAiCompatibleModels("http://127.0.0.1:1", "", { fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")) }),
    /Nothing answered at http:\/\/127.0.0.1:1\/v1/,
  );
  await assert.rejects(
    listOpenAiCompatibleModels("http://127.0.0.1:1", "", { fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })) }),
    /listed no models/,
  );
});
