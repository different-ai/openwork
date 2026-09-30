import { afterEach, expect, test, vi } from "vitest";
import { configuredLiveProvider } from "../worlds/installed-live-gateway.ts";

afterEach(() => vi.unstubAllEnvs());

test("credentials alone never opt into real inference", async () => {
  vi.stubEnv("OPENWORK_LIVE_INSTALLED_GATEWAY", "");
  vi.stubEnv("OPENWORK_LIVE_PROVIDER", "");
  vi.stubEnv("OPENAI_API_KEY", "synthetic-test-key");
  expect(await configuredLiveProvider()).toBeNull();
});

test("explicit direct OpenAI preserves the credential destination and both selected models", async () => {
  vi.stubEnv("OPENWORK_LIVE_INSTALLED_GATEWAY", "");
  vi.stubEnv("OPENWORK_LIVE_PROVIDER", "OpenAI");
  vi.stubEnv("OPENWORK_LIVE_KEY_ENV", "OPENWORK_TEST_PROVIDER_KEY");
  vi.stubEnv("OPENWORK_TEST_PROVIDER_KEY", "synthetic-test-key");
  vi.stubEnv("OPENWORK_LIVE_MODELS", "model-one,model-two");
  const provider = await configuredLiveProvider();
  expect(provider?.baseURL).toBe("https://api.openai.com/v1");
  expect(provider?.key).toBe("synthetic-test-key");
  expect(provider?.models.map(model => model.id)).toEqual(["model-one", "model-two"]);
});

test("missing credentials fail instead of falling back to a scripted model", async () => {
  vi.stubEnv("OPENWORK_LIVE_INSTALLED_GATEWAY", "");
  vi.stubEnv("OPENWORK_LIVE_PROVIDER", "OpenAI");
  vi.stubEnv("OPENWORK_LIVE_KEY_ENV", "OPENWORK_TEST_PROVIDER_KEY");
  vi.stubEnv("OPENWORK_TEST_PROVIDER_KEY", "");
  vi.stubEnv("OPENWORK_LIVE_MODELS", "model-one,model-two");
  await expect(configuredLiveProvider()).rejects.toThrow("no mock fallback");
});
