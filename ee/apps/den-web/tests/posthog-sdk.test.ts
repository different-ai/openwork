import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CaptureResult, PostHog } from "posthog-js";
import { beforeSendPosthog } from "../posthog-privacy";

const token = "phc_eng108_offline_test_not_a_real_project";
const origin = "https://app.openworklabs.com";

test("real SDK immediately identifies, captures and resets offline; only outbound person updates are scrubbed", async () => {
  let deniedRequests = 0;
  function denyNetwork(): never {
    deniedRequests++;
    throw new TypeError("Failed to fetch: offline SDK test denies all network");
  }

  GlobalRegistrator.register({
    url: `${origin}/dashboard?code=synthetic#fragment`,
    settings: {
      enableJavaScriptEvaluation: false,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      enableImageFileLoading: false,
      disableIframePageLoading: true,
      navigation: {
        disableMainFrameNavigation: true,
        disableChildFrameNavigation: true,
        disableChildPageNavigation: true,
      },
      fetch: { interceptor: { beforeAsyncRequest: denyNetwork, beforeSyncRequest: denyNetwork } },
    },
  });

  const dom = globalThis as typeof globalThis & { happyDOM: { close(): Promise<void> } };
  let posthog: PostHog | undefined;
  let unsubscribe: (() => void) | undefined;
  const captured: CaptureResult[] = [];
  const authCookie = "better-auth.session_token=synthetic-test-only";

  try {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: denyNetwork });
    XMLHttpRequest.prototype.open = denyNetwork;
    XMLHttpRequest.prototype.send = denyNetwork;
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: denyNetwork });
    Object.defineProperty(navigator, "webdriver", { configurable: true, value: false });
    const extraTransports = ["WebSocket", "EventSource", "Worker", "SharedWorker"];
    const originals = new Map(extraTransports.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const key of extraTransports) {
      Object.defineProperty(globalThis, key, { configurable: true, value: denyNetwork });
    }

    try {
      expect(window.fetch).toBe(denyNetwork);
      expect(window.navigator.sendBeacon).toBe(denyNetwork);
      expect(window.XMLHttpRequest.prototype.send).toBe(denyNetwork);
      expect(() => fetch(`${origin}/ow/guard-check`)).toThrow("denies all network");
      expect(() => new XMLHttpRequest().open("POST", "/ow/guard-check")).toThrow("denies all network");
      expect(() => navigator.sendBeacon("/ow/guard-check")).toThrow("denies all network");
      expect(deniedRequests).toBe(3);

      Object.defineProperty(document, "referrer", {
        configurable: true,
        value: `${origin}/reauth?nonce=synthetic-referrer-secret#grant=synthetic-fragment`,
      });
      document.cookie = `${authCookie}; Path=/; Secure; SameSite=Lax`;
      expect(document.cookie).toBe(authCookie);
      expect(localStorage.length).toBe(0);

      posthog = (await import("posthog-js")).default;
      unsubscribe = posthog.on("eventCaptured", (event: CaptureResult) => captured.push(event));
      posthog.init(token, {
        api_host: "/ow",
        ui_host: "https://us.posthog.com",
        defaults: "2026-05-30",
        persistence: "localStorage",
        cross_subdomain_cookie: false,
        person_profiles: "identified_only",
        capture_pageview: "history_change",
        capture_pageleave: false,
        autocapture: false,
        rageclick: false,
        disable_session_recording: true,
        disable_surveys: true,
        advanced_disable_flags: true,
        save_referrer: false,
        save_campaign_params: false,
        before_send: beforeSendPosthog,
      });
      const initialId = posthog.get_distinct_id();
      posthog.identify("synthetic-user-A", { email: "a@example.test", name: "Fixture A", plan: "free" },
        { email: "first@example.test", name: "First fixture", cohort: "offline" });
      const identityA = posthog.capture("eng108_identity_a", { sequence: 1 });
      posthog.reset();
      const resetId = posthog.get_distinct_id();
      const anonymous = posthog.capture("eng108_after_reset", { sequence: 2 });
      posthog.identify("synthetic-user-B", { email: "b@example.test", name: "Fixture B", plan: "team" });
      const identityB = posthog.capture("eng108_identity_b", { sequence: 3 });

      expect(initialId).toEqual(expect.any(String));
      expect(initialId.length).toBeGreaterThan(0);
      expect(resetId).toEqual(expect.any(String));
      expect(resetId.length).toBeGreaterThan(0);
      expect(resetId).not.toBe(initialId);
      expect(resetId).not.toBe("synthetic-user-A");
      expect(posthog.get_distinct_id()).toBe("synthetic-user-B");
      for (const [result, event, distinctId, sequence] of [
        [identityA, "eng108_identity_a", "synthetic-user-A", 1],
        [anonymous, "eng108_after_reset", resetId, 2],
        [identityB, "eng108_identity_b", "synthetic-user-B", 3],
      ] as const) {
        expect(result).toMatchObject({
          event,
          uuid: expect.any(String),
          timestamp: expect.any(Date),
          properties: { token, distinct_id: distinctId, sequence, $lib_version: "1.430.2", $current_url: `${origin}/dashboard` },
        });
        expect(result).not.toBeInstanceOf(Promise);
        expect(captured.find((entry) => entry.event === event)).toBe(result);
      }
      const identifies = captured.filter((event) => event.event === "$identify");
      expect(identifies).toHaveLength(2);
      expect(identifies[0]).toMatchObject({
        properties: { token, distinct_id: "synthetic-user-A", $anon_distinct_id: initialId },
        $set: { plan: "free" }, $set_once: { cohort: "offline" },
      });
      expect(identifies[1]).toMatchObject({
        properties: { token, distinct_id: "synthetic-user-B", $anon_distinct_id: resetId },
        $set: { plan: "team" },
      });

      // Re-identifying an already-known user emits nested person updates.
      posthog.identify("synthetic-user-B", { email: "returning@example.test", name: "Returning User", plan: "returning" });
      const returning = captured.findLast((event) => event.event === "$set");
      expect(returning?.properties.$set).toMatchObject({ plan: "returning" });
      expect(returning?.properties.$set).not.toHaveProperty("email");
      expect(returning?.properties.$set).not.toHaveProperty("name");
      expect(captured.some((event) => event.properties.$session_entry_referrer === `${origin}/reauth`)).toBe(true);
      expect(JSON.stringify(captured)).not.toContain("synthetic-referrer-secret");
      expect(JSON.stringify(captured)).not.toContain("synthetic-fragment");

      posthog.register({ email: "existing@example.test", name: "Existing properties are allowed to persist" });
      const existing = posthog.capture("eng108_existing_properties");
      expect(existing?.properties).not.toHaveProperty("email");
      expect(existing?.properties).not.toHaveProperty("name");
      // The documented outbound hook does not rewrite SDK persistence.
      expect(posthog.get_property("email")).toBe("existing@example.test");
      for (const event of captured) {
        expect(event.properties.token).toBe(token);
        for (const update of [event.$set, event.$set_once]) {
          if (update) {
            expect(update).not.toHaveProperty("email");
            expect(update).not.toHaveProperty("name");
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
        .some((key) => key?.includes(token))).toBe(true);
      expect(document.cookie).toBe(authCookie);

      posthog.opt_out_capturing();
      expect(posthog.has_opted_out_capturing()).toBe(true);
      const count = captured.length;
      expect(posthog.capture("eng108_must_not_capture")).toBeUndefined();
      expect(captured).toHaveLength(count);
      expect(document.cookie).toBe(authCookie);
    } finally {
      try {
        unsubscribe?.();
        posthog?.opt_out_capturing();
        posthog?.set_config({ disable_persistence: true });
        await posthog?.shutdown();
        expect(document.cookie).toBe(authCookie);
      } finally {
        await dom.happyDOM.close();
        for (const [key, descriptor] of originals) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
      }
    }
  } finally {
    await GlobalRegistrator.unregister();
  }
});
