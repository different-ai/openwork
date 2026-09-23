import { describe, expect, mock, test } from "bun:test";
import type { NextConfig } from "next";
import type { CaptureResult, PostHogConfig } from "posthog-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { beforeSendPosthog } from "../posthog-privacy";
import * as scrub from "../observability/scrub";

type Env = Record<string, string | undefined>;
const appDir = fileURLToPath(new URL("../", import.meta.url));
const readSource = (file: string) => readFileSync(join(appDir, file), "utf8");
const token = "phc_eng108_test_project";
const origin = "https://app.openworklabs.com";
const compiled = new Map<string, string>();

function evaluate<T>(file: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  let code = compiled.get(file);
  if (code === undefined) {
    code = file.endsWith(".ts")
      ? transpileModule(readSource(file), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
      }).outputText
      : readSource(file);
    compiled.set(file, code);
  }
  const module = { exports: {} };
  runInNewContext(code, {
    module, exports: module.exports, __dirname: appDir, URL,
    ...globals,
    require(id: string) {
      if (!Object.hasOwn(imports, id)) throw new Error(`Unexpected sandbox import: ${id}`);
      return imports[id];
    },
  }, { filename: join(appDir, file), timeout: 1_000 });
  return module.exports as T;
}

const browserConfig = evaluate<typeof import("../observability/browser-config")>(
  "observability/browser-config.ts",
  { "@openwork-ee/utils/observability": { ObservabilityConfigError: Error } },
);

function instrumentation(options: {
  env?: Env;
  browser?: boolean;
  origin?: string;
  existing?: object;
  throws?: boolean;
} = {}) {
  const window: { location: { origin: string }; posthog?: object } = {
    location: { origin: options.origin ?? origin }, posthog: options.existing,
  };
  const init = mock((_token: string, _config: Partial<PostHogConfig>) => {
    expect(window.posthog).toBe(options.existing);
    if (options.throws) throw new Error("Synthetic SDK initialization failure");
    return { notTheImportedSingleton: true };
  });
  const sdk = Object.freeze({ init, capture: mock(), identify: mock(), reset: mock() });
  const sentry = { init: mock((_config: Record<string, unknown>) => {}), captureRouterTransitionStart: mock() };
  const env = { NODE_ENV: "production", NEXT_PUBLIC_POSTHOG_KEY: token, ...options.env };
  const run = () => evaluate<{ onRouterTransitionStart: (...args: unknown[]) => void }>(
    "instrumentation-client.ts",
    {
      "posthog-js": { default: sdk },
      "@sentry/nextjs": sentry,
      "./posthog-privacy": { beforeSendPosthog },
      "./observability/browser-config": browserConfig,
      "./observability/scrub": scrub,
    },
    { process: { env }, ...(options.browser === false ? {} : { window }) },
  );
  return { ...run(), run, window, sdk, sentry };
}

describe("official PostHog instrumentation", () => {
  test("KEY-only initialization immediately exposes the imported singleton without callbacks or wrappers", () => {
    const result = instrumentation();
    expect(result.sdk.init).toHaveBeenCalledTimes(1);
    expect(result.window.posthog).toBe(result.sdk);
    expect(result.sdk.init).toHaveBeenCalledWith(token, expect.objectContaining({
      api_host: "/ow", ui_host: "https://us.posthog.com", defaults: "2026-05-30",
      persistence: "localStorage", cross_subdomain_cookie: false,
      person_profiles: "identified_only", capture_pageview: "history_change",
      capture_pageleave: false, autocapture: false, rageclick: false,
      disable_session_recording: true, disable_surveys: true, advanced_disable_flags: true,
      save_referrer: false, save_campaign_params: false, before_send: beforeSendPosthog,
    }));
    expect(result.sdk.init.mock.calls[0]?.[1]).not.toHaveProperty("loaded");
    result.run();
    expect(result.sdk.init).toHaveBeenCalledTimes(1);
    expect(result.window.posthog).toBe(result.sdk);
    expect(result.sentry.init).not.toHaveBeenCalled();
    result.onRouterTransitionStart();
    expect(result.sentry.captureRouterTransitionStart).not.toHaveBeenCalled();
  });

  const ineligible: [string, Parameters<typeof instrumentation>[0]][] = [
    ["server execution", { browser: false }],
    ["development", { env: { NODE_ENV: "development" } }],
    ["test environment", { env: { NODE_ENV: "test" } }],
    ["unset NODE_ENV", { env: { NODE_ENV: undefined } }],
    ["missing public key", { env: { NEXT_PUBLIC_POSTHOG_KEY: undefined } }],
    ["blank public key", { env: { NEXT_PUBLIC_POSTHOG_KEY: "" } }],
    ["project alias without an emitted KEY", { env: { NEXT_PUBLIC_POSTHOG_KEY: undefined, NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token } }],
    ["legacy alias without an emitted KEY", { env: { NEXT_PUBLIC_POSTHOG_KEY: undefined, DEN_WEB_POSTHOG_KEY: token } }],
    ["blank emitted KEY with aliases present", { env: { NEXT_PUBLIC_POSTHOG_KEY: "", NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token, DEN_WEB_POSTHOG_KEY: token } }],
    ["localhost", { origin: "http://localhost:3005" }],
    ["preview origin", { origin: "https://eng108-preview.example.test" }],
    ["self-hosted origin", { origin: "https://selfhost.example.test" }],
    ["non-HTTPS canonical host", { origin: "http://app.openworklabs.com" }],
    ["lookalike origin", { origin: "https://app.openworklabs.com.example.test" }],
  ];
  test.each(ineligible)("skips initialization for %s", (_name: string, options: Parameters<typeof instrumentation>[0]) => {
    const result = instrumentation(options);
    expect(result.sdk.init).not.toHaveBeenCalled();
    expect(result.window.posthog).toBeUndefined();
  });

  test("does not overwrite a pre-existing global client", () => {
    const existing = Object.freeze({ capture: mock() });
    const result = instrumentation({ existing });
    expect(result.sdk.init).not.toHaveBeenCalled();
    expect(result.window.posthog).toBe(existing);
  });

  const sentryCases: [string, NonNullable<Parameters<typeof instrumentation>[0]>, number][] = [
    ["init exception", { throws: true }, 1],
    ["blank KEY", { env: { NEXT_PUBLIC_POSTHOG_KEY: "" } }, 0],
    ["missing KEY", { env: { NEXT_PUBLIC_POSTHOG_KEY: undefined } }, 0],
    ["EU host", { env: { NEXT_PUBLIC_POSTHOG_HOST: "https://eu.i.posthog.com" } }, 1],
  ];
  test.each(sentryCases)("PostHog %s does not alter Sentry initialization or its router hook", (_name, options, calls) => {
    const env = {
      NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND: "sentry",
      NEXT_PUBLIC_SENTRY_DSN: "https://public@sentry.example.test/123",
      NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: "0.25",
    };
    const baseline = instrumentation({ env });
    const result = instrumentation({ ...options, env: { ...env, ...options.env } });
    expect(result.sdk.init).toHaveBeenCalledTimes(calls);
    expect(result.window.posthog).toBe(options.throws || calls === 0 ? undefined : result.sdk);
    expect(result.sentry.init).toHaveBeenCalledTimes(1);
    const normalConfig = baseline.sentry.init.mock.calls[0]?.[0];
    const resultConfig = result.sentry.init.mock.calls[0]?.[0];
    if (!normalConfig || !resultConfig) throw new Error("Expected both Sentry initializations");
    const { beforeSendLog: normalLog, ...normalOptions } = normalConfig;
    const { beforeSendLog: resultLog, ...resultOptions } = resultConfig;
    expect(resultOptions).toEqual(normalOptions);
    if (typeof normalLog !== "function" || typeof resultLog !== "function") {
      throw new Error("Expected Sentry log scrubbers");
    }
    const log = { message: "GET /dashboard?token=private", attributes: { token: "private" } };
    expect(resultLog(log)).toEqual(normalLog(log));
    expect(result.sentry.init).toHaveBeenCalledWith(expect.objectContaining({
      dsn: env.NEXT_PUBLIC_SENTRY_DSN, tracesSampleRate: 0.25,
      sendDefaultPii: false, beforeSend: scrub.scrubSentryEvent,
    }));
    expect(result.onRouterTransitionStart).toBe(result.sentry.captureRouterTransitionStart);
    result.onRouterTransitionStart("/dashboard", "push", "pushState");
    expect(result.sentry.captureRouterTransitionStart).toHaveBeenCalledTimes(1);
  });

  test("keeps raw bootstraps, custom queues and SDK method replacements out of client source", () => {
    const source = ["instrumentation-client.ts", "posthog-privacy.ts", "app/layout.tsx"]
      .map(readSource).join("\n");
    expect(source).not.toMatch(/posthog-bootstrap|__openworkPosthog|__SV|_i\s*=|createElement\(["']script|array\.js/);
    expect(source).not.toMatch(/\b(?:queue|pendingCalls)\s*=|posthog\s*=\s*\[|\.push\(\s*\[\s*["'](?:capture|identify|reset)/);
    expect(source).not.toMatch(/\bposthog(?:\.(?:capture|identify|reset)|\[["'](?:capture|identify|reset)["']\])\s*=/);
    expect(readSource("instrumentation-client.ts")).toContain('import posthog from "posthog-js"');
    expect(readSource("instrumentation-client.ts")).toContain("window.posthog = posthog");
  });
});

function nextConfig(env: Env) {
  return evaluate<NextConfig>("next.config.js", {
    path: { join },
    "./next-config-den-api-redirects.cjs": evaluate("next-config-den-api-redirects.cjs", {}),
    "./observability/next-config-observability.cjs": {
      withObservabilityNextConfig: (config: NextConfig) => config,
    },
  }, { process: { env } });
}

describe("PostHog existing public build-time key", () => {
  const aliases = { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: "phc_project_alias", DEN_WEB_POSTHOG_KEY: "phc_legacy_alias" };
  const cases: [string, Env, string][] = [
    ["unset", {}, ""],
    ["blank", { NEXT_PUBLIC_POSTHOG_KEY: "" }, ""],
    ["whitespace", { NEXT_PUBLIC_POSTHOG_KEY: " \t " }, ""],
    ["existingKeyProduction without aliases or new token names", { NEXT_PUBLIC_POSTHOG_KEY: token }, token],
    ["trimmed primary", { NEXT_PUBLIC_POSTHOG_KEY: ` ${token} ` }, token],
    ["project alias when KEY is unset", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token }, token],
    ["trimmed project alias", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: ` ${token} ` }, token],
    ["legacy alias when KEY and project alias are unset", { DEN_WEB_POSTHOG_KEY: token }, token],
    ["trimmed legacy alias", { DEN_WEB_POSTHOG_KEY: ` ${token} ` }, token],
    ["primary wins over both aliases", { ...aliases, NEXT_PUBLIC_POSTHOG_KEY: token }, token],
    ["primary works with blank aliases", { NEXT_PUBLIC_POSTHOG_KEY: token, NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: "", DEN_WEB_POSTHOG_KEY: "" }, token],
    ["primary works with invalid aliases", { NEXT_PUBLIC_POSTHOG_KEY: token, NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: "invalid", DEN_WEB_POSTHOG_KEY: "invalid" }, token],
    ["project alias precedes legacy alias", aliases, aliases.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN],
    ["explicit blank KEY blocks both aliases", { ...aliases, NEXT_PUBLIC_POSTHOG_KEY: "" }, ""],
    ["whitespace KEY blocks both aliases", { ...aliases, NEXT_PUBLIC_POSTHOG_KEY: " \t " }, ""],
    ["invalid KEY blocks both aliases", { ...aliases, NEXT_PUBLIC_POSTHOG_KEY: "invalid" }, ""],
    ["blank project alias blocks legacy alias", { ...aliases, NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: "" }, ""],
    ["whitespace project alias blocks legacy alias", { ...aliases, NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: " \t " }, ""],
    ["invalid project alias blocks legacy alias", { ...aliases, NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: "invalid" }, ""],
    ["invalid legacy alias", { DEN_WEB_POSTHOG_KEY: "invalid" }, ""],
    ["missing key suffix", { ...aliases, NEXT_PUBLIC_POSTHOG_KEY: "phc_" }, ""],
    ["invalid key characters", { ...aliases, NEXT_PUBLIC_POSTHOG_KEY: "phc_bad token" }, ""],
    ["oversized key", { ...aliases, NEXT_PUBLIC_POSTHOG_KEY: `phc_${"a".repeat(201)}` }, ""],
    ["maximum key length", { NEXT_PUBLIC_POSTHOG_KEY: `phc_${"a".repeat(200)}` }, `phc_${"a".repeat(200)}`],
    ["allowed key characters", { NEXT_PUBLIC_POSTHOG_KEY: "phc_A0-z_9" }, "phc_A0-z_9"],
    ["zero dev mode", { NEXT_PUBLIC_POSTHOG_KEY: token, OPENWORK_DEV_MODE: "0" }, token],
    ["blank dev mode", { NEXT_PUBLIC_POSTHOG_KEY: token, OPENWORK_DEV_MODE: "" }, token],
  ];
  test.each(cases)("%s emits KEY and initializes only when eligible", (_name, overrides, expected) => {
    const env = {
      NODE_ENV: "production", VERCEL_ENV: "production",
      PRIVATE_TEST_VALUE: "must-stay-server-side", ...overrides,
    };
    const before = { ...env };
    const config = nextConfig(env);
    expect(config.env).toEqual({ NEXT_PUBLIC_POSTHOG_KEY: expected, NEXT_PUBLIC_POSTHOG_HOST: "https://us.i.posthog.com" });
    expect(env).toEqual(before);
    const result = instrumentation({ env: config.env });
    expect(result.sdk.init).toHaveBeenCalledTimes(expected ? 1 : 0);
    expect(result.window.posthog).toBe(expected ? result.sdk : undefined);
    if (expected) {
      expect(result.sdk.init).toHaveBeenCalledWith(expected, expect.objectContaining({ api_host: "/ow", ui_host: "https://us.posthog.com" }));
    }
  });

  const disabled: [string, Env][] = [
    ["preview", { VERCEL_ENV: "preview" }],
    ["Vercel development", { VERCEL_ENV: "development" }],
    ["self-hosted", { VERCEL_ENV: undefined }],
    ["development build", { NODE_ENV: "development" }],
    ["test build", { NODE_ENV: "test" }],
    ["unset NODE_ENV", { NODE_ENV: undefined }],
    ["explicit dev mode", { OPENWORK_DEV_MODE: "1" }],
    ["other nonzero dev mode", { OPENWORK_DEV_MODE: "true" }],
  ];
  test.each(disabled)("%s disables KEY and both alias fallbacks even at the canonical origin", (_name, overrides) => {
    for (const credentials of [{ NEXT_PUBLIC_POSTHOG_KEY: token }, aliases, { DEN_WEB_POSTHOG_KEY: token }]) {
      for (const host of ["https://us.i.posthog.com", "https://eu.i.posthog.com"]) {
        const config = nextConfig({
          NODE_ENV: "production", VERCEL_ENV: "production", NEXT_PUBLIC_POSTHOG_HOST: host,
          ...credentials, ...overrides,
        });
        expect(config.env).toEqual({ NEXT_PUBLIC_POSTHOG_KEY: "", NEXT_PUBLIC_POSTHOG_HOST: host });
        const result = instrumentation({ env: config.env });
        expect(result.sdk.init).not.toHaveBeenCalled();
        expect(result.window.posthog).toBeUndefined();
      }
    }
  });

  test("preserves ordered PostHog rewrites, trailing slash policy, and Den redirects", async () => {
    const config = nextConfig({ DEN_API_PUBLIC_URL: "https://api.example.test" });
    expect(config.skipTrailingSlashRedirect).toBe(true);
    expect(await config.rewrites?.()).toEqual([
      { source: "/ow/static/:path*", destination: "https://us-assets.i.posthog.com/static/:path*" },
      { source: "/ow/array/:path*", destination: "https://us-assets.i.posthog.com/array/:path*" },
      { source: "/ow/:path*", destination: "https://us.i.posthog.com/:path*" },
    ]);
    expect(await config.redirects?.()).toEqual([
      { source: "/api/den/:path*", destination: "https://api.example.test/:path*", permanent: false },
    ]);
    expect(await nextConfig({}).redirects?.()).toEqual([]);
  });
});

describe("PostHog existing public host selects only the upstream region", () => {
  const cases: [string, string | undefined, "us" | "eu"][] = [
    ["default US", undefined, "us"],
    ["empty host defaults to US", "", "us"],
    ["whitespace host defaults to US", " \t ", "us"],
    ["US API", "https://us.i.posthog.com", "us"],
    ["EU API", "https://eu.i.posthog.com", "eu"],
    ["legacy US UI", "https://app.posthog.com", "us"],
    ["US UI", "https://us.posthog.com", "us"],
    ["EU UI", "https://eu.posthog.com", "eu"],
    ["existing proxy path", "/ow", "us"],
    ["US API trailing slash", "https://us.i.posthog.com/", "us"],
    ["EU API trailing slash", "https://eu.i.posthog.com/", "eu"],
    ["legacy US UI trailing slash", "https://app.posthog.com/", "us"],
    ["US UI trailing slash", "https://us.posthog.com/", "us"],
    ["EU UI trailing slash", "https://eu.posthog.com/", "eu"],
    ["proxy trailing slash", "/ow/", "us"],
    ["trimmed US host with trailing slashes", " https://us.i.posthog.com/// \t", "us"],
    ["trimmed EU host with trailing slashes", " https://eu.posthog.com/// \t", "eu"],
  ];
  test.each(cases)("%s keeps ordered runtime rewrites and the browser API on /ow", async (_name, host, region) => {
    const env = {
      NODE_ENV: "production", VERCEL_ENV: "production",
      NEXT_PUBLIC_POSTHOG_KEY: token, NEXT_PUBLIC_POSTHOG_HOST: host,
    };
    const before = { ...env };
    const config = nextConfig(env);
    expect(env).toEqual(before);
    expect(config.env).toEqual({ NEXT_PUBLIC_POSTHOG_KEY: token, NEXT_PUBLIC_POSTHOG_HOST: `https://${region}.i.posthog.com` });
    expect(config.skipTrailingSlashRedirect).toBe(true);
    expect(await config.rewrites?.()).toEqual([
      { source: "/ow/static/:path*", destination: `https://${region}-assets.i.posthog.com/static/:path*` },
      { source: "/ow/array/:path*", destination: `https://${region}-assets.i.posthog.com/array/:path*` },
      { source: "/ow/:path*", destination: `https://${region}.i.posthog.com/:path*` },
    ]);
    const result = instrumentation({ env: config.env });
    expect(result.sdk.init).toHaveBeenCalledTimes(1);
    expect(result.sdk.init).toHaveBeenCalledWith(token, expect.objectContaining({ api_host: "/ow", ui_host: `https://${region}.posthog.com` }));
    expect(result.window.posthog).toBe(result.sdk);
  });

  const rejected: [string, string][] = [
    ["unsupported origin", "https://unsupported.example.test"],
    ["lookalike origin", "https://us.i.posthog.com.example.test"],
    ["non-HTTPS origin", "http://us.i.posthog.com"],
    ["protocol-relative origin", "//eu.i.posthog.com"],
    ["credentialed US origin", "https://fixture:host-secret@us.i.posthog.com"],
    ["credentialed EU origin", "https://fixture:host-secret@eu.i.posthog.com"],
    ["credentialed UI origin", "https://fixture:host-secret@app.posthog.com"],
    ["username-only origin", "https://fixture@eu.posthog.com"],
    ["US path", "https://us.i.posthog.com/e/"],
    ["EU path", "https://eu.i.posthog.com/static/"],
    ["UI path", "https://eu.posthog.com/project/fixture"],
    ["US query", "https://us.i.posthog.com?token=host-secret"],
    ["EU query", "https://eu.i.posthog.com/?token=host-secret"],
    ["UI query", "https://app.posthog.com?token=host-secret"],
    ["fragment", "https://eu.posthog.com#host-secret"],
    ["proxy child path", "/ow/e/"],
    ["proxy query", "/ow?token=host-secret"],
    ["explicit port", "https://us.i.posthog.com:443"],
    ["malformed origin", "https://[invalid"],
  ];
  test.each(rejected)("active production with a valid KEY rejects %s without leaking the value", (_name, host) => {
    const env = {
      NODE_ENV: "production", VERCEL_ENV: "production",
      NEXT_PUBLIC_POSTHOG_KEY: token, NEXT_PUBLIC_POSTHOG_HOST: host,
    };
    const before = { ...env };
    let error: unknown;
    try {
      nextConfig(env);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      name: "Error",
      message: "NEXT_PUBLIC_POSTHOG_HOST must be a US/EU PostHog Cloud HTTPS origin or /ow.",
    });
    expect(String(error)).not.toContain(host);
    expect(String(error)).not.toContain("host-secret");
    expect(env).toEqual(before);
  });

  const disabled: [string, Env][] = [
    ["preview", { VERCEL_ENV: "preview" }],
    ["Vercel development", { VERCEL_ENV: "development" }],
    ["self-hosted", { VERCEL_ENV: undefined }],
    ["development build", { NODE_ENV: "development" }],
    ["test build", { NODE_ENV: "test" }],
    ["unset NODE_ENV", { NODE_ENV: undefined }],
    ["explicit dev mode", { OPENWORK_DEV_MODE: "1" }],
    ["other nonzero dev mode", { OPENWORK_DEV_MODE: "true" }],
    ["missing KEY and aliases", { NEXT_PUBLIC_POSTHOG_KEY: undefined }],
    ["blank KEY", { NEXT_PUBLIC_POSTHOG_KEY: "" }],
    ["whitespace KEY", { NEXT_PUBLIC_POSTHOG_KEY: " \t " }],
    ["invalid KEY", { NEXT_PUBLIC_POSTHOG_KEY: "invalid" }],
    ["missing key suffix", { NEXT_PUBLIC_POSTHOG_KEY: "phc_" }],
    ["invalid key characters", { NEXT_PUBLIC_POSTHOG_KEY: "phc_bad token" }],
    ["oversized key", { NEXT_PUBLIC_POSTHOG_KEY: `phc_${"a".repeat(201)}` }],
    ["blank KEY overriding valid aliases", { NEXT_PUBLIC_POSTHOG_KEY: "", NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token, DEN_WEB_POSTHOG_KEY: token }],
    ["invalid KEY overriding valid aliases", { NEXT_PUBLIC_POSTHOG_KEY: "invalid", NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token, DEN_WEB_POSTHOG_KEY: token }],
  ];
  const disabledHosts = [
    ...rejected.map(([, host]) => ({ host, region: "us" })),
    { host: "https://eu.i.posthog.com", region: "eu" },
    { host: "https://eu.posthog.com/", region: "eu" },
  ];
  test.each(disabled)("%s tolerates unsupported HOST with US defaults and retains valid EU hosts without SDK initialization", async (_name, overrides) => {
    for (const { host, region } of disabledHosts) {
      const env = {
        NODE_ENV: "production", VERCEL_ENV: "production",
        NEXT_PUBLIC_POSTHOG_KEY: token, NEXT_PUBLIC_POSTHOG_HOST: host, ...overrides,
      };
      const before = { ...env };
      const config = nextConfig(env);
      expect(env).toEqual(before);
      expect(config.env).toEqual({ NEXT_PUBLIC_POSTHOG_KEY: "", NEXT_PUBLIC_POSTHOG_HOST: `https://${region}.i.posthog.com` });
      expect(await config.rewrites?.()).toEqual([
        { source: "/ow/static/:path*", destination: `https://${region}-assets.i.posthog.com/static/:path*` },
        { source: "/ow/array/:path*", destination: `https://${region}-assets.i.posthog.com/array/:path*` },
        { source: "/ow/:path*", destination: `https://${region}.i.posthog.com/:path*` },
      ]);
      const result = instrumentation({ env: config.env });
      expect(result.sdk.init).not.toHaveBeenCalled();
      expect(result.window.posthog).toBeUndefined();
    }
  });
});

describe("SDK-shaped PostHog before_send payloads", () => {
  test.each(["$pageview", "$identify"])("scrubs %s without mutating the SDK envelope", (eventName: string) => {
    const dirtyUrl = "https://fixture:password@app.openworklabs.com/dashboard?code=private#fragment";
    const urls = Object.fromEntries([
      "$current_url", "$initial_current_url", "$referrer", "$initial_referrer",
      "$session_entry_url", "$session_exit_url",
    ].map((key) => [key, dirtyUrl]));
    const event: CaptureResult = {
      uuid: "00000000-0000-4000-8000-000000000108", event: eventName,
      timestamp: new Date("2026-01-01T00:00:00.000Z"),
      properties: { token, distinct_id: "fixture-user", $device_id: "fixture-device", count: 3, ...urls },
      ...(eventName === "$identify" ? {
        $set: { email: "person@example.test", name: "Fixture Person", plan: "team", ...urls },
        $set_once: { email: "first@example.test", name: "First Name", cohort: "fixture", ...urls },
      } : {}),
    };
    const original = structuredClone(event);
    Object.freeze(event.properties);
    if (event.$set) Object.freeze(event.$set);
    if (event.$set_once) Object.freeze(event.$set_once);
    Object.freeze(event);
    const result = beforeSendPosthog(event);
    if (result === null) throw new Error("Valid SDK event was dropped");
    const cleanUrls = Object.fromEntries(Object.keys(urls).map((key) => [key, `${origin}/dashboard`]));
    expect(result).toEqual({
      ...event,
      properties: { token, distinct_id: "fixture-user", $device_id: "fixture-device", count: 3, ...cleanUrls },
      ...(eventName === "$identify" ? {
        $set: { plan: "team", ...cleanUrls }, $set_once: { cohort: "fixture", ...cleanUrls },
      } : {}),
    });
    expect(result).not.toBe(event);
    expect(result.properties).not.toBe(event.properties);
    expect(result.timestamp).toBe(event.timestamp);
    expect(event).toEqual(original);
  });

  test("handles direct, relative, malformed and non-HTTP URL properties", () => {
    const event: CaptureResult = {
      uuid: "00000000-0000-4000-8000-000000000108", event: "fixture-event",
      properties: {
        token, $referrer: "$direct", $initial_referrer: 42,
        $current_url: "/dashboard?token=private#fragment",
        $initial_current_url: "https://[invalid",
        $session_entry_url: "javascript:alert(1)",
        $session_exit_url: "http://fixture:password@example.test/exit?token=private#fragment",
      },
    };
    const original = structuredClone(event);
    expect(beforeSendPosthog(event)?.properties).toEqual({
      token, $referrer: "$direct", $initial_referrer: 42,
      $current_url: `${origin}/dashboard`, $initial_current_url: "[redacted URL]",
      $session_entry_url: "[redacted URL]", $session_exit_url: "http://example.test/exit",
    });
    expect(event).toEqual(original);
  });
});
