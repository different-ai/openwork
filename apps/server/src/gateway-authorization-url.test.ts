import { describe, expect, test } from "bun:test";
import { gatewayAuthorizationUrl } from "./cloud-provider-sync.js";

const session = { baseUrl: "https://api.example.test", token: "synthetic-session-token", orgId: "org_fixture" };

describe("Gateway browser authorization URLs", () => {
  test("preserves the authenticated Den response's HTTPS bridge URL without rewriting the attempt", () => {
    const url = "https://den.example.test/gateway/connect?attempt=fixture%2Bvalue";
    expect(gatewayAuthorizationUrl(url, session)).toBe(url);
  });

  test("continues accepting the legacy Google authorization endpoint", () => {
    const url = "https://accounts.google.com/o/oauth2/v2/auth?state=fixture";
    expect(gatewayAuthorizationUrl(url, session)).toBe(url);
  });

  test("allows separate local API and web ports only when both are HTTP loopback origins", () => {
    const local = { ...session, baseUrl: "http://127.0.0.1:3000" };
    const url = "http://127.0.0.1:3005/gateway/connect?attempt=fixture";
    expect(gatewayAuthorizationUrl(url, local)).toBe(url);
    expect(() => gatewayAuthorizationUrl(url, session)).toThrow();
    expect(() => gatewayAuthorizationUrl("http://remote.example.test/gateway/connect", local)).toThrow();
  });

  test.each([
    "https://den.example.test/gateway/connect?token=synthetic-session-token",
    "https://den.example.test/gateway/connect?token=%73ynthetic-session-token",
    "https://den.example.test/gateway/connect#fragment",
    "https://user:password@den.example.test/gateway/connect",
    "https://den.example.test/unrelated",
    "https://accounts.google.com/unrelated",
    "http://den.example.test/gateway/connect",
    "javascript:alert(1)",
    "openwork://gateway/connect",
    "//den.example.test/gateway/connect",
    "",
  ])("rejects credentials, unrelated destinations and unsafe transport: %s", (url) => {
    expect(() => gatewayAuthorizationUrl(url, session)).toThrow("Den returned an invalid authorization URL");
  });
});
