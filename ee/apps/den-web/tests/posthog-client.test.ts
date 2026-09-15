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
  const env = { NODE_ENV: "production", NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token, ...options.env };
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
  test("immediately exposes the imported singleton without a loaded callback or method wrappers", () => {
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
    ["missing public token", { env: { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: undefined } }],
    ["blank public token", { env: { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: "" } }],
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

  test("an init exception does not alter Sentry initialization or its router hook", () => {
    const env = {
      NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND: "sentry",
      NEXT_PUBLIC_SENTRY_DSN: "https://public@sentry.example.test/123",
      NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: "0.25",
    };
    const baseline = instrumentation({ env });
    const failed = instrumentation({ env, throws: true });
    expect(failed.sdk.init).toHaveBeenCalledTimes(1);
    expect(failed.window.posthog).toBeUndefined();
    expect(failed.sentry.init).toHaveBeenCalledTimes(1);
    const normalConfig = baseline.sentry.init.mock.calls[0]?.[0];
    const failedConfig = failed.sentry.init.mock.calls[0]?.[0];
    if (!normalConfig || !failedConfig) throw new Error("Expected both Sentry initializations");
    const { beforeSendLog: normalLog, ...normalOptions } = normalConfig;
    const { beforeSendLog: failedLog, ...failedOptions } = failedConfig;
    expect(failedOptions).toEqual(normalOptions);
    if (typeof normalLog !== "function" || typeof failedLog !== "function") {
      throw new Error("Expected Sentry log scrubbers");
    }
    const log = { message: "GET /dashboard?token=private", attributes: { token: "private" } };
    expect(failedLog(log)).toEqual(normalLog(log));
    expect(failed.sentry.init).toHaveBeenCalledWith(expect.objectContaining({
      dsn: env.NEXT_PUBLIC_SENTRY_DSN, tracesSampleRate: 0.25,
      sendDefaultPii: false, beforeSend: scrub.scrubSentryEvent,
    }));
    expect(failed.onRouterTransitionStart).toBe(failed.sentry.captureRouterTransitionStart);
    failed.onRouterTransitionStart("/dashboard", "push", "pushState");
    expect(failed.sentry.captureRouterTransitionStart).toHaveBeenCalledTimes(1);
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

describe("PostHog public build-time token", () => {
  const cases: [string, Env, string][] = [
    ["unset", {}, ""],
    ["blank", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: "" }, ""],
    ["whitespace", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: " \t " }, ""],
    ["primary", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token }, token],
    ["trimmed primary", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: ` ${token} ` }, token],
    ["legacy fallback only when unset", { DEN_WEB_POSTHOG_KEY: token }, token],
    ["trimmed fallback", { DEN_WEB_POSTHOG_KEY: ` ${token} ` }, token],
    ["primary wins", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token, DEN_WEB_POSTHOG_KEY: "phc_other" }, token],
    ["explicit blank blocks fallback", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: "", DEN_WEB_POSTHOG_KEY: token }, ""],
    ["whitespace blocks fallback", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: " \t ", DEN_WEB_POSTHOG_KEY: token }, ""],
    ["invalid primary blocks fallback", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: "invalid", DEN_WEB_POSTHOG_KEY: token }, ""],
    ["invalid fallback", { DEN_WEB_POSTHOG_KEY: "invalid" }, ""],
    ["missing token suffix", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: "phc_" }, ""],
    ["invalid token characters", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: "phc_bad token" }, ""],
    ["oversized token", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: `phc_${"a".repeat(201)}` }, ""],
    ["preview", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token, VERCEL_ENV: "preview" }, ""],
    ["Vercel development", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token, VERCEL_ENV: "development" }, ""],
    ["self-hosted", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token, VERCEL_ENV: undefined }, ""],
    ["development build", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token, NODE_ENV: "development" }, ""],
    ["test build", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token, NODE_ENV: "test" }, ""],
    ["unset NODE_ENV", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token, NODE_ENV: undefined }, ""],
    ["explicit dev mode", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token, OPENWORK_DEV_MODE: "1" }, ""],
    ["other nonzero dev mode", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token, OPENWORK_DEV_MODE: "true" }, ""],
    ["zero dev mode", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token, OPENWORK_DEV_MODE: "0" }, token],
    ["blank dev mode", { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token, OPENWORK_DEV_MODE: "" }, token],
  ];
  test.each(cases)("%s exposes only the eligible public token", (_name: string, overrides: Env, expected: string) => {
    const env = {
      NODE_ENV: "production", VERCEL_ENV: "production",
      PRIVATE_TEST_VALUE: "must-stay-server-side", ...overrides,
    };
    const before = { ...env };
    expect(nextConfig(env).env).toEqual({ NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: expected });
    expect(env).toEqual(before);
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
